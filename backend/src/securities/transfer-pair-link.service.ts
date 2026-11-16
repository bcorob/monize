import { BadRequestException, Injectable, Logger } from "@nestjs/common";
import { DataSource, EntityManager } from "typeorm";

import { withScopedDb } from "../common/db/scoped-db";
import { returnedRows } from "../common/db/query-result";
import { tr } from "../i18n/translate";
import { HoldingsService } from "./holdings.service";
import { InvestmentTransaction } from "./entities/investment-transaction.entity";
import {
  UNFILTERED_INVESTMENT_SCOPE_SQL,
  resolveInvestmentScopeAccountIds,
} from "./investment-scope.util";
import {
  TRANSFER_LEG_PAIRS,
  UnlinkedTransferPair,
  UnlinkedTransferPairRow,
  toUnlinkedTransferPairs,
  unlinkedTransferPairsSql,
} from "./unlinked-transfer-pairs.util";

/**
 * The two legs of one share transfer that nothing paired, and the repair.
 *
 * `transferSecurity` writes `linked_transaction_id` on both rows it creates,
 * and the cost-basis replay matches on exactly that: an unpaired `TRANSFER_IN`
 * cannot take the basis its source released, so that position's basis -- and
 * the gain over it -- is reported `transferred_basis_unknown`. Rows written by
 * an import were created independently and carry no pairing, which is the state
 * this exists to get a reader out of.
 *
 * **Finding is a suggestion; linking is a command.** The read offers candidates
 * (`unlinked-transfer-pairs.util.ts` says what makes one) and no measure
 * consults them: inferring a pairing inside a valuation would be a guess
 * wearing a figure's clothes. The write acts only on the two ids a person
 * named, re-checks every condition inside the transaction that does the
 * linking, and refuses before writing anything if one no longer holds.
 */
/** What a confirmed link did, and nothing it did not work out. */
export interface LinkedTransferPair {
  outTransactionId: string;
  inTransactionId: string;
  securityId: string;
  /** The accounts whose stored holdings the pairing let this rebuild. */
  rebuiltAccountIds: string[];
}

@Injectable()
export class TransferPairLinkService {
  private readonly logger = new Logger(TransferPairLinkService.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly holdings: HoldingsService,
  ) {}

  /**
   * Candidates over the portfolio, or over `accountIds` when the caller is
   * looking at part of it. Read-only.
   */
  async findCandidates(
    userId: string,
    accountIds?: string[],
  ): Promise<UnlinkedTransferPair[]> {
    return withScopedDb(this.dataSource, async (manager) => {
      const scope = await this.scopeAccountIds(userId, manager, accountIds);
      if (scope.length === 0) return [];
      const rows = returnedRows<UnlinkedTransferPairRow>(
        await manager.query(unlinkedTransferPairsSql(), [userId, scope]),
      );
      return toUnlinkedTransferPairs(rows);
    });
  }

  /**
   * Pair the two legs a person confirmed, and rebuild the basis the pairing
   * now lets the destination carry.
   *
   * Every check runs inside the one transaction that writes, under `FOR UPDATE`
   * on both rows: a leg linked by a concurrent request, or edited out of the
   * pair's shape, must refuse rather than be overwritten. The rebuild is in the
   * same transaction because the basis it writes is only correct against the
   * link, and a commit carrying one without the other would leave a holding
   * whose stored average no longer matches its ledger.
   */
  async linkPair(
    userId: string,
    outTransactionId: string,
    inTransactionId: string,
  ): Promise<LinkedTransferPair> {
    if (outTransactionId === inTransactionId) {
      throw new BadRequestException(
        tr(
          "errors.securities.transferPairSameRow",
          "A transfer's two legs cannot be the same transaction",
        ),
      );
    }

    return withScopedDb(this.dataSource, async (manager) => {
      // Rows as RECORDS, includes VOID: a void leg has to be READ in order to
      // be refused. `assertPairable` names it as the reason the pairing was
      // rejected, which a query that filtered it out could not do -- the two
      // rows would simply be "not found", and a reader would go looking for a
      // deletion that never happened.
      const repo = manager.getRepository(InvestmentTransaction);
      // Locked in id order, so two requests over one pair cannot deadlock.
      const [first, second] = [outTransactionId, inTransactionId].sort();
      const locked = await repo
        .createQueryBuilder("it")
        .setLock("pessimistic_write")
        .where("it.id IN (:...ids)", { ids: [first, second] })
        .andWhere("it.userId = :userId", { userId })
        .getMany();

      const out = locked.find((row) => row.id === outTransactionId);
      const into = locked.find((row) => row.id === inTransactionId);
      if (!out || !into) {
        throw new BadRequestException(
          tr(
            "errors.securities.transferPairNotFound",
            "One of the two transactions no longer exists",
          ),
        );
      }

      this.assertPairable(out, into);

      const scope = await this.scopeAccountIds(userId, manager, undefined);
      if (!scope.includes(out.accountId) || !scope.includes(into.accountId)) {
        throw new BadRequestException(
          tr(
            "errors.securities.transferPairOutsidePortfolio",
            "Both legs must be on investment accounts of this portfolio",
          ),
        );
      }

      await repo.update(out.id, { linkedTransactionId: into.id });
      await repo.update(into.id, { linkedTransactionId: out.id });

      // The destination can now take the basis the source released, which only
      // a replay of both ledgers works out.
      await this.holdings.rebuildScopesFromTransactions(
        userId,
        [
          { accountId: out.accountId, securityId: out.securityId as string },
          { accountId: into.accountId, securityId: into.securityId as string },
        ],
        manager,
      );

      this.logger.log(
        `Linked transfer legs ${out.id} and ${into.id} for user ${userId}`,
      );

      return {
        outTransactionId: out.id,
        inTransactionId: into.id,
        securityId: out.securityId as string,
        // The scopes whose stored basis this rebuilt, so a caller knows which
        // holdings to re-read rather than guessing at the whole portfolio.
        rebuiltAccountIds: [out.accountId, into.accountId],
      };
    });
  }

  /**
   * The same conditions the candidate query applies, re-asserted on two rows a
   * caller named. Spelled here rather than by re-running that query because a
   * refusal has to name which condition failed, and a query that returns no
   * row cannot.
   */
  private assertPairable(
    out: InvestmentTransaction,
    into: InvestmentTransaction,
  ): void {
    const refuse = (key: string, fallback: string) => {
      throw new BadRequestException(tr(key, fallback));
    };

    if (out.linkedTransactionId || into.linkedTransactionId) {
      refuse(
        "errors.securities.transferPairAlreadyLinked",
        "One of these legs is already linked to another transaction",
      );
    }
    if (out.status === "VOID" || into.status === "VOID") {
      refuse(
        "errors.securities.transferPairVoid",
        "A void transaction recorded nothing, so it cannot be half of a transfer",
      );
    }
    const matchesAPair = TRANSFER_LEG_PAIRS.some(
      ([outAction, inAction]) =>
        out.action === outAction && into.action === inAction,
    );
    if (!matchesAPair) {
      refuse(
        "errors.securities.transferPairActions",
        "These two actions are not the outgoing and incoming legs of one transfer",
      );
    }
    if (!out.securityId || out.securityId !== into.securityId) {
      refuse(
        "errors.securities.transferPairSecurity",
        "Both legs must move the same security",
      );
    }
    if (String(out.transactionDate) !== String(into.transactionDate)) {
      refuse(
        "errors.securities.transferPairDate",
        "Both legs must be dated the same day",
      );
    }
    if (out.accountId === into.accountId) {
      refuse(
        "errors.securities.transferPairSameAccount",
        "A transfer moves shares between two different accounts",
      );
    }
    const outQuantity = Math.abs(Number(out.quantity) || 0);
    const inQuantity = Math.abs(Number(into.quantity) || 0);
    if (outQuantity === 0 || outQuantity !== inQuantity) {
      refuse(
        "errors.securities.transferPairQuantity",
        "Both legs must move the same number of shares",
      );
    }
  }

  /** The portfolio's accounts, widened to linked pairs as valuation does. */
  private async scopeAccountIds(
    userId: string,
    manager: EntityManager,
    accountIds?: string[],
  ): Promise<string[]> {
    if (accountIds && accountIds.length > 0) {
      return resolveInvestmentScopeAccountIds(
        (sql, params) => manager.query(sql, params as unknown[]),
        userId,
        accountIds,
      );
    }
    const rows = returnedRows<{ id: string }>(
      await manager.query(
        `SELECT a.id FROM accounts a
          WHERE a.user_id = $1 AND ${UNFILTERED_INVESTMENT_SCOPE_SQL}`,
        [userId],
      ),
    );
    return rows.map((row) => row.id);
  }
}
