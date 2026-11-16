import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { DataSource, EntityManager, In } from "typeorm";
import { withScopedDb } from "../common/db/scoped-db";
import { withSystemContext } from "../common/db/with-context";
import { tr } from "../i18n/translate";
import { Account } from "../accounts/entities/account.entity";
import { User } from "../users/entities/user.entity";
import { AccountDelegate } from "./entities/account-delegate.entity";
import { AccountDelegateGrant } from "./entities/account-delegate-grant.entity";
import { DelegateOperation } from "./decorators/delegate-access.decorator";

/** How the real user reaches an account: they own it, or it is shared to them. */
export interface AccountAccess {
  account: Account;
  ownerUserId: string;
  via: "own" | "delegation";
}

/**
 * An account the real user may name as the "other side" of a transfer beyond
 * the effective user's own list. Deliberately carries NO balance or
 * institution data -- only what the transfer form needs to render and gate
 * the option.
 */
export interface TransferCandidate {
  id: string;
  name: string;
  currencyCode: string;
  accountType: string;
  accountSubType: string | null;
  isClosed: boolean;
  ownerLabel: string;
  canCreate: boolean;
  canEdit: boolean;
  canDelete: boolean;
}

/**
 * Cross-owner account authorization for transfers (cross-owner-transfers plan,
 * Phase 1). The single rule: for each account a transfer touches, the REAL
 * user (`req.user.realUserId`) must either own it or hold an active delegation
 * from its owner with the matching per-account grant. Own-context requests
 * bypass the delegate guard entirely, so this service -- not the guard -- is
 * the authoritative check; the guard stays as defense-in-depth for acting
 * tokens.
 *
 * Lives beside DelegationService rather than inside it because that file is at
 * the line-count cap.
 */
@Injectable()
export class CrossOwnerAccessService {
  constructor(private dataSource: DataSource) {}

  /**
   * Authorize `realUserId` to perform `op` on `accountId`, whoever owns it.
   * Decision order: account exists -> owned by the real user -> `via: "own"`;
   * else an active delegation from the account's owner with a READ grant row
   * -> op flag check -> `via: "delegation"` or 403; else 404. An account the
   * real user cannot read 404s exactly like a nonexistent one -- never
   * confirm existence.
   */
  async accountAccessFor(
    realUserId: string,
    accountId: string,
    op: DelegateOperation,
  ): Promise<AccountAccess> {
    const account = await this.loadAccountForAuthorization(accountId);
    if (!account) {
      throw this.accountNotFound(accountId);
    }
    if (account.userId === realUserId) {
      return { account, ownerUserId: realUserId, via: "own" };
    }

    const grant = await withScopedDb(this.dataSource, async (manager) => {
      const delegation = await manager.getRepository(AccountDelegate).findOne({
        where: {
          ownerUserId: account.userId,
          delegateUserId: realUserId,
          status: "active",
        },
      });
      if (!delegation) return null;
      return manager.getRepository(AccountDelegateGrant).findOne({
        where: { delegationId: delegation.id, accountId, canRead: true },
      });
    });
    if (!grant) {
      throw this.accountNotFound(accountId);
    }
    if (!this.grantAllows(grant, op)) {
      throw new ForbiddenException(
        tr(
          "errors.delegation.accountOperationNotGranted",
          `The account owner has not granted you permission to ${op} transactions in this account.`,
          { operation: op },
        ),
      );
    }
    return { account, ownerUserId: account.userId, via: "delegation" };
  }

  /**
   * Re-assert, inside the write's own transaction, the access
   * `accountAccessFor` (or `JointAccountsService.jointAccessFor`) granted
   * earlier.
   *
   * Authorization runs in the grantee's identity and the write under the
   * system bypass, which is a different transaction, so a revoke that
   * committed between the two let the write land in the owner's ledger after
   * consent was withdrawn (A26-M04). Called on the write's manager, after its
   * row locks and before its first write: `FOR SHARE` on the delegation and
   * grant rows makes a concurrent revoke (a `DELETE` of the delegation, which
   * cascades to the grants) wait for this transaction to commit, or makes this
   * read see the rows gone. Refuses with the same 404 / 403 the first check
   * answers. An account the real user owns needs no grant.
   */
  async assertAccessStillHeld(
    m: EntityManager,
    realUserId: string,
    accountId: string,
    op: DelegateOperation,
    { joint = false }: { joint?: boolean } = {},
  ): Promise<void> {
    const owners: { user_id: string }[] = await m.query(
      `SELECT user_id FROM accounts WHERE id = $1`,
      [accountId],
    );
    if (owners.length === 0) throw this.accountNotFound(accountId);
    const ownerUserId = owners[0].user_id;
    if (ownerUserId === realUserId) return;

    const grants: {
      can_create: boolean;
      can_edit: boolean;
      can_delete: boolean;
    }[] = await m.query(
      `SELECT g.can_create, g.can_edit, g.can_delete
         FROM account_delegates d
         JOIN account_delegate_grants g ON g.delegation_id = d.id
        WHERE d.owner_user_id = $1
          AND d.delegate_user_id = $2
          AND d.status = 'active'
          AND g.account_id = $3
          AND g.can_read
          AND ($4::boolean IS FALSE OR g.is_joint)
          FOR SHARE OF d, g`,
      [ownerUserId, realUserId, accountId, joint],
    );
    if (grants.length === 0) throw this.accountNotFound(accountId);
    const [grant] = grants;
    const allowed = this.grantAllows(
      {
        canCreate: grant.can_create,
        canEdit: grant.can_edit,
        canDelete: grant.can_delete,
      },
      op,
    );
    if (!allowed) {
      throw new ForbiddenException(
        tr(
          "errors.delegation.accountOperationNotGranted",
          `The account owner has not granted you permission to ${op} transactions in this account.`,
          { operation: op },
        ),
      );
    }
  }

  /**
   * Every account id the real user may read: their own accounts plus every
   * `can_read`-granted account across all active delegations where they are
   * the delegate. One definition serves counterpart masking in both contexts
   * (acting-as-owner, and the delegate's own session).
   */
  async readableAccountIdSetFor(realUserId: string): Promise<Set<string>> {
    // Authorization-decision read: while acting as an owner the ambient
    // identity cannot see the real user's own account rows, so the own-account
    // id list is read under system context (ids only, nothing returned to the
    // client).
    const ownIds = await withSystemContext(() =>
      withScopedDb(this.dataSource, (manager) =>
        manager.getRepository(Account).find({
          where: { userId: realUserId },
          select: ["id"],
        }),
      ),
    );

    const grantedIds = await withScopedDb(this.dataSource, async (manager) => {
      const delegations = await manager.getRepository(AccountDelegate).find({
        where: { delegateUserId: realUserId, status: "active" },
        select: ["id"],
      });
      if (delegations.length === 0) return [] as AccountDelegateGrant[];
      return manager.getRepository(AccountDelegateGrant).find({
        where: {
          delegationId: In(delegations.map((d) => d.id)),
          canRead: true,
        },
        select: ["accountId"],
      });
    });

    return new Set<string>([
      ...ownIds.map((a) => a.id),
      ...grantedIds.map((g) => g.accountId),
    ]);
  }

  /**
   * The accounts the real user can add to a transfer beyond the effective
   * user's own list (Phase 4). Own context: accounts shared TO the real user
   * through active delegations with a READ grant, with the per-op write
   * flags. Acting context (effective != real): the real user's OWN accounts,
   * every flag true.
   */
  async transferCandidatesFor(
    realUserId: string,
    effectiveUserId: string,
  ): Promise<TransferCandidate[]> {
    if (realUserId !== effectiveUserId) {
      // Acting as an owner: offer the delegate's own accounts.
      // Authorization-decision read -- the acting identity cannot see the
      // real user's rows; only the fields below leave this method.
      const [accounts, self] = await withSystemContext(() =>
        withScopedDb(this.dataSource, async (manager) => {
          const own = await manager.getRepository(Account).find({
            where: { userId: realUserId },
            order: { name: "ASC" },
          });
          const user = await manager
            .getRepository(User)
            .findOne({ where: { id: realUserId } });
          return [own, user] as const;
        }),
      );
      const ownerLabel = self ? this.userLabel(self) : realUserId;
      return accounts.map((account) =>
        this.toCandidate(account, ownerLabel, {
          canCreate: true,
          canEdit: true,
          canDelete: true,
        }),
      );
    }

    // Own context: accounts shared to the real user.
    const delegations = await withScopedDb(this.dataSource, (manager) =>
      manager.getRepository(AccountDelegate).find({
        where: { delegateUserId: realUserId, status: "active" },
        relations: ["owner"],
      }),
    );
    if (delegations.length === 0) return [];

    const grants = await withScopedDb(this.dataSource, (manager) =>
      manager.getRepository(AccountDelegateGrant).find({
        where: {
          delegationId: In(delegations.map((d) => d.id)),
          canRead: true,
        },
      }),
    );
    if (grants.length === 0) return [];

    // Authorization-decision read: the granted rows belong to the owners;
    // the READ grants above are what authorize returning these fields.
    const accounts = await withSystemContext(() =>
      withScopedDb(this.dataSource, (manager) =>
        manager.getRepository(Account).find({
          where: { id: In(grants.map((g) => g.accountId)) },
          order: { name: "ASC" },
        }),
      ),
    );

    const labelByDelegation = new Map(
      delegations.map((d) => [
        d.id,
        d.owner ? this.userLabel(d.owner) : d.ownerUserId,
      ]),
    );
    const grantByAccount = new Map(grants.map((g) => [g.accountId, g]));

    return accounts.flatMap((account) => {
      const grant = grantByAccount.get(account.id);
      if (!grant) return [];
      return [
        this.toCandidate(
          account,
          labelByDelegation.get(grant.delegationId) ?? account.userId,
          {
            canCreate: grant.canCreate,
            canEdit: grant.canEdit,
            canDelete: grant.canDelete,
          },
        ),
      ];
    });
  }

  private toCandidate(
    account: Account,
    ownerLabel: string,
    flags: { canCreate: boolean; canEdit: boolean; canDelete: boolean },
  ): TransferCandidate {
    return {
      id: account.id,
      name: account.name,
      currencyCode: account.currencyCode,
      accountType: account.accountType,
      accountSubType: account.accountSubType ?? null,
      isClosed: account.isClosed,
      ownerLabel,
      ...flags,
    };
  }

  private userLabel(user: User): string {
    const name = [user.firstName, user.lastName].filter(Boolean).join(" ");
    return name || user.email || user.id;
  }

  /** Whether `accountId` exists and is owned by `userId`. */
  async isAccountOwnedBy(accountId: string, userId: string): Promise<boolean> {
    // Authorization-decision read: the delegate guard calls this under an
    // acting (owner-scoped) identity to probe the real user's OWN account,
    // which that identity cannot see -- so the existence probe runs under
    // system context. Nothing beyond the boolean leaves this method.
    return withSystemContext(() =>
      withScopedDb(this.dataSource, (manager) =>
        manager.getRepository(Account).exists({
          where: { id: accountId, userId },
        }),
      ),
    );
  }

  /**
   * Authorization-decision read: the account row is loaded by id with no user
   * filter -- learning a foreign account's owner is the decision input, and
   * the row is only returned to callers after `accountAccessFor` has
   * authorized the real user against it.
   */
  private loadAccountForAuthorization(
    accountId: string,
  ): Promise<Account | null> {
    return withSystemContext(() =>
      withScopedDb(this.dataSource, (manager) =>
        manager.getRepository(Account).findOne({ where: { id: accountId } }),
      ),
    );
  }

  private grantAllows(
    grant: Pick<AccountDelegateGrant, "canCreate" | "canEdit" | "canDelete">,
    op: DelegateOperation,
  ): boolean {
    switch (op) {
      case "read":
        return true;
      case "create":
        return grant.canCreate;
      case "edit":
        return grant.canEdit;
      case "delete":
        return grant.canDelete;
    }
  }

  /** The same 404 shape the owner-scoped account lookup produces today. */
  private accountNotFound(accountId: string): NotFoundException {
    return new NotFoundException(
      tr(
        "errors.accounts.accountWithIdNotFound",
        `Account with ID ${accountId} not found`,
        { id: accountId },
      ),
    );
  }
}
