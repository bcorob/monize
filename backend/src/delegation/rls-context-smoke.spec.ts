import { DelegationService } from "./delegation.service";
import { AccountDelegate } from "./entities/account-delegate.entity";
import { AccountDelegateGrant } from "./entities/account-delegate-grant.entity";
import { User } from "../users/entities/user.entity";
import { UserPreference } from "../users/entities/user-preference.entity";
import { RefreshToken } from "../auth/entities/refresh-token.entity";
import { PersonalAccessToken } from "../auth/entities/personal-access-token.entity";
import { TrustedDevice } from "../users/entities/trusted-device.entity";
import { OAUTH_GRANT_REVOKER } from "../auth/credential-revocation";
import { Account } from "../accounts/entities/account.entity";
import { getRequestContext, RequestContext } from "../common/request-context";
import { withUserContext } from "../common/db/with-context";
import { createScopedDbMocks } from "../test-helpers/scoped-db-testing";

jest.mock("bcryptjs", () => ({
  hash: jest.fn().mockResolvedValue("hashed"),
}));

/**
 * Identity smoke for Shared Access, run against the REAL `withScopedDb` at
 * `RLS_MODE=enforce` -- the mode the deployment this was reported from runs in.
 *
 * `delegation.service.spec.ts` mocks `withScopedDb` away, which is right for
 * asserting what the service computes and structurally blind to which identity
 * it computes it under. That blindness is the whole bug: every read below was
 * issued under the caller's own scope, and `users_self` answers a question
 * about somebody else's row with zero rows rather than an error. Nothing threw,
 * nothing logged, and the Add-delegate form quietly reported an existing Monize
 * account as new.
 *
 * So these tests assert the identity, twice over and at two different levels:
 * the ambient context each repository call actually ran in, and the `set_config`
 * statements `withScopedDb` emitted for it. A read that regresses to `scoped()`
 * fails on both.
 *
 * The pairing matters as much as the bypass. An owner-side read is expected to
 * bypass ONLY after the authorization read that licenses it has run under the
 * owner's own scope -- so the tests assert the whole ordered sequence of
 * identities, not merely that a bypass appears somewhere in it.
 */
describe("Shared Access RLS identity smoke (real withScopedDb)", () => {
  const OWNER_ID = "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
  const DELEGATE_ID = "d1a2b3c4-5e6f-4a7b-8c9d-0e1f2a3b4c5d";
  const DELEGATION_ID = "b2c3d4e5-6f7a-4b8c-9d0e-1f2a3b4c5d6e";

  const BYPASS_SQL = "SELECT set_config('app.bypass_rls', 'on', true)";
  const CURRENT_SQL = "SELECT set_config('app.current_user_id', $1, true)";
  const REAL_SQL = "SELECT set_config('app.real_user_id', $1, true)";

  const originalMode = process.env.RLS_MODE;

  /** One entry per recorded DB call, in the order the service made them. */
  interface Seen {
    op: string;
    ctx: RequestContext | undefined;
  }

  let seen: Seen[];
  let manager: Record<string, jest.Mock>;
  let dataSource: { transaction: jest.Mock; query: jest.Mock };
  let service: DelegationService;

  /**
   * A mock repository whose every method records the ambient context it ran
   * under before returning its canned value. Recording inside the call is the
   * point: the context is transaction-local, so reading it afterwards would
   * report whatever the last caller left behind.
   */
  function repo(
    label: string,
    impls: Record<string, unknown>,
  ): Record<string, jest.Mock> {
    return Object.fromEntries(
      Object.entries(impls).map(([method, value]) => [
        method,
        jest.fn(async () => {
          seen.push({ op: `${label}.${method}`, ctx: getRequestContext() });
          return typeof value === "function" ? value() : value;
        }),
      ]),
    );
  }

  /** The identity each recorded call ran under, in order. */
  function identities(): string[] {
    return seen.map(({ op, ctx }) => {
      if (ctx?.system) return `${op}: bypass`;
      if (!ctx?.userId) return `${op}: NO CONTEXT`;
      return `${op}: current=${ctx.userId} real=${ctx.realUserId ?? ctx.userId}`;
    });
  }

  /** The set_config statements withScopedDb actually emitted, in order. */
  function gucs(): string[] {
    return manager.query.mock.calls.map(([sql, params]: [string, string[]]) =>
      params?.length ? `${sql} <- ${params[0]}` : sql,
    );
  }

  beforeEach(() => {
    process.env.RLS_MODE = "enforce";
    seen = [];
  });

  afterEach(() => {
    if (originalMode === undefined) delete process.env.RLS_MODE;
    else process.env.RLS_MODE = originalMode;
  });

  /** Wire the service up over the given repositories. */
  function build(repos: Array<[unknown, Record<string, jest.Mock>]>) {
    const mocks = createScopedDbMocks(
      repos as Array<[never, Record<string, jest.Mock>]>,
    );
    manager = mocks.manager;
    dataSource = mocks.dataSource;
    service = new DelegationService(
      { getStatus: jest.fn().mockReturnValue({ configured: false }) } as never,
      { get: jest.fn((_k: string, d: string) => d) } as never,
      dataSource as never,
      {} as never,
      {
        get: jest.fn((token: unknown) =>
          token === OAUTH_GRANT_REVOKER
            ? { revokeAllForUser: jest.fn().mockResolvedValue(0) }
            : undefined,
        ),
      } as never,
    );
    return mocks;
  }

  // -------------------------------------------------------------------------
  // The reported bug.
  // -------------------------------------------------------------------------

  it("delegateEmailExists looks the address up across users, not within the caller's scope", async () => {
    build([[User, repo("users", { findOne: null })]]);

    const exists = await withUserContext(OWNER_ID, () =>
      service.delegateEmailExists("Someone.Else@Example.com"),
    );

    expect(exists).toBe(false);
    // The regression: this read used to run as `current=OWNER real=OWNER`,
    // where users_self can only ever match the owner's own row -- so the
    // answer was "no such user" for every address but the caller's own.
    expect(identities()).toEqual(["users.findOne: bypass"]);
    expect(gucs()).toEqual([BYPASS_SQL]);
  });

  it("createDelegate provisions the delegate's login under a bypass so an existing account is linked, not duplicated", async () => {
    const usersRepo = repo("users", {
      findOne: { id: OWNER_ID, email: "o@e.f" },
    });
    build([[User, usersRepo]]);

    // The transaction body reaches the EntityManager directly.
    manager.findOne = jest.fn(async (entity: unknown) => {
      seen.push({
        op: `manager.findOne(${(entity as { name: string }).name})`,
        ctx: getRequestContext(),
      });
      return entity === User
        ? { id: DELEGATE_ID, passwordHash: "existing" }
        : null;
    });
    manager.count = jest.fn(async () => 1);
    manager.create = jest.fn((_e: unknown, v: unknown) => v);
    manager.save = jest.fn(async (v: unknown) => ({
      id: DELEGATION_ID,
      ...(v as object),
    }));

    await withUserContext(OWNER_ID, () =>
      service.createDelegate(OWNER_ID, {
        email: "existing@example.com",
      } as never),
    );

    // Every statement, including the owner lookup, runs under the bypass:
    // the read that finds the existing login and the write that links it have
    // to agree, so they share one identity and one transaction.
    // Two transactions (the owner lookup, then the provisioning unit), both
    // announcing the same identity to the database.
    expect(identities().every((line) => line.endsWith(": bypass"))).toBe(true);
    expect(gucs()).toEqual([BYPASS_SQL, BYPASS_SQL]);
    // Found the existing user -- no second users row was created for it.
    expect(manager.create).not.toHaveBeenCalledWith(User, expect.anything());
  });

  // -------------------------------------------------------------------------
  // The rest of the same surface, which the same defect reached.
  // -------------------------------------------------------------------------

  it("listDelegates decides authorization in the owner's scope, then hydrates the delegates outside it", async () => {
    build([
      [
        AccountDelegate,
        repo("delegations", {
          find: [
            {
              id: DELEGATION_ID,
              status: "active",
              createdAt: new Date("2026-01-01"),
              delegateUserId: DELEGATE_ID,
              grants: [],
            },
          ],
          count: 1,
        }),
      ],
      [
        User,
        repo("users", {
          find: [{ id: DELEGATE_ID, email: "d@e.f", firstName: "D" }],
          findOne: { id: DELEGATE_ID, isDelegateOnly: true, role: "user" },
        }),
      ],
      [Account, repo("accounts", { count: 0 })],
    ]);

    const [summary] = await withUserContext(OWNER_ID, () =>
      service.listDelegates(OWNER_ID),
    );

    // The email is the visible half of the bug: as `relations: ["delegate"]`
    // this joined to nothing under enforcement and every delegate listed blank.
    expect(summary.delegate.email).toBe("d@e.f");
    // Order is the assertion. The owner's own delegations come first, under
    // the owner's own identity -- that read is what licenses everything after
    // it. Only then does the hydration cross into the delegate's row.
    expect(identities()[0]).toBe(
      `delegations.find: current=${OWNER_ID} real=${OWNER_ID}`,
    );
    expect(
      identities()
        .slice(1)
        .every((line) => line.endsWith(": bypass")),
    ).toBe(true);
    expect(gucs()[0]).toBe(`${CURRENT_SQL} <- ${OWNER_ID}`);
    expect(gucs()).toContain(BYPASS_SQL);
  });

  it("isFullAccount answers about the delegate rather than about whoever asked", async () => {
    build([
      [Account, repo("accounts", { count: 3 })],
      [AccountDelegate, repo("delegations", { count: 0 })],
      [User, repo("users", { findOne: { id: DELEGATE_ID, role: "user" } })],
    ]);

    // Three counts the owner's scope cannot see. Under the old scoping they
    // came back 0/0/null, and this answered "not a full account" for a user
    // with three accounts -- the permissive answer on every call site.
    await expect(
      withUserContext(OWNER_ID, () => service.isFullAccount(DELEGATE_ID)),
    ).resolves.toBe(true);
    expect(identities().every((line) => line.endsWith(": bypass"))).toBe(true);
  });

  it("resetDelegatePassword rotates the credential and cuts the sessions across the user boundary", async () => {
    const usersRepo = repo("users", {
      findOne: { id: DELEGATE_ID, isDelegateOnly: true, oidcSubject: null },
      save: {},
    });
    const refreshTokens = repo("refreshTokens", { update: { affected: 2 } });
    build([
      [
        AccountDelegate,
        repo("delegations", {
          findOne: {
            id: DELEGATION_ID,
            ownerUserId: OWNER_ID,
            delegateUserId: DELEGATE_ID,
          },
          // No other delegation and no data of their own: an owner-provisioned
          // credential, which is the only kind an owner may rotate.
          count: 0,
        }),
      ],
      [User, usersRepo],
      [Account, repo("accounts", { count: 0 })],
      [RefreshToken, refreshTokens],
      [PersonalAccessToken, repo("pats", { update: { affected: 1 } })],
      [TrustedDevice, repo("trustedDevices", { delete: { affected: 1 } })],
    ]);
    // The converging refresh revocation after the commit opens with a raw
    // SELECT of the delegate's live families; none are left here.
    const setConfig = manager.query.getMockImplementation();
    manager.query.mockImplementation((sql: string, params?: unknown[]) =>
      sql.includes("SELECT DISTINCT family_id")
        ? Promise.resolve([])
        : (setConfig?.(sql, params) ?? Promise.resolve(undefined)),
    );

    await withUserContext(OWNER_ID, () =>
      service.resetDelegatePassword(OWNER_ID, DELEGATION_ID),
    );

    // Ownership is proved first, in the owner's own scope.
    expect(identities()[0]).toBe(
      `delegations.findOne: current=${OWNER_ID} real=${OWNER_ID}`,
    );
    // The save and the revoke are the two that must not be scoped away: a
    // password written to nothing, and sessions on the old password surviving
    // a reset that reported success.
    expect(identities()).toContain("users.save: bypass");
    expect(identities()).toContain("refreshTokens.update: bypass");
    // So must the PATs and trusted devices the old password stood behind.
    expect(identities()).toContain("pats.update: bypass");
    expect(identities()).toContain("trustedDevices.delete: bypass");
    // And the post-commit convergence reaches the delegate's own sessions.
    expect(manager.query).toHaveBeenCalledWith(
      expect.stringContaining("SELECT DISTINCT family_id"),
      [DELEGATE_ID, null],
    );
  });

  it("revokeDelegate decides whether to delete the login on rows it can actually read", async () => {
    build([
      [
        AccountDelegate,
        repo("delegations", {
          findOne: {
            id: DELEGATION_ID,
            ownerUserId: OWNER_ID,
            delegateUserId: DELEGATE_ID,
          },
        }),
      ],
    ]);
    manager.delete = jest.fn(async (entity: unknown) => {
      seen.push({
        op: `manager.delete(${(entity as { name: string }).name})`,
        ctx: getRequestContext(),
      });
      return { affected: 1 };
    });
    // A delegate who owns data: the login must survive the revoke.
    manager.count = jest.fn(async (entity: unknown) => {
      seen.push({
        op: `manager.count(${(entity as { name: string }).name})`,
        ctx: getRequestContext(),
      });
      return entity === Account ? 4 : 0;
    });
    manager.findOne = jest.fn(async () => ({
      id: DELEGATE_ID,
      role: "user",
      isDelegateOnly: false,
    }));

    await withUserContext(OWNER_ID, () =>
      service.revokeDelegate(OWNER_ID, DELEGATION_ID),
    );

    expect(identities()[0]).toBe(
      `delegations.findOne: current=${OWNER_ID} real=${OWNER_ID}`,
    );
    expect(
      identities()
        .slice(1)
        .every((line) => line.endsWith(": bypass")),
    ).toBe(true);
    // Scoped to the owner, that account count read 0 and this DELETE was
    // reached for a delegate with four accounts of their own.
    expect(manager.delete).not.toHaveBeenCalledWith(User, expect.anything());
  });

  // -------------------------------------------------------------------------
  // The delegate's side of the same wall. These take no bypass at all: the
  // delegation is an identity the policies already understand.
  // -------------------------------------------------------------------------

  it("delegateMustEnrollOwn2FA reads the owner's 2FA state under the delegation, not under a bypass", async () => {
    build([
      [
        User,
        repo("users", {
          findOne: () => ({ id: OWNER_ID, twoFactorSecret: "s" }),
        }),
      ],
      [UserPreference, repo("prefs", { findOne: { twoFactorEnabled: true } })],
    ]);

    // The delegate's own session: current = real = delegate. The owner's rows
    // are outside it, so this used to see null, conclude the owner did not
    // require 2FA, and wave the delegate through the gate it exists to impose.
    const mustEnroll = await withUserContext(DELEGATE_ID, () =>
      service.delegateMustEnrollOwn2FA(OWNER_ID, DELEGATE_ID),
    );

    expect(mustEnroll).toBe(false); // owner requires it, delegate has it too
    expect(
      identities().every((line) =>
        line.endsWith(`current=${OWNER_ID} real=${DELEGATE_ID}`),
      ),
    ).toBe(true);
    expect(identities().some((line) => line.endsWith(": bypass"))).toBe(false);
    // Both GUCs, and they differ -- which is the whole point of the pairing.
    expect(gucs()).toContain(`${CURRENT_SQL} <- ${OWNER_ID}`);
    expect(gucs()).toContain(`${REAL_SQL} <- ${DELEGATE_ID}`);
    expect(gucs()).not.toContain(BYPASS_SQL);
  });

  it("getAvailableContexts labels an owner from the owner's row, reached through the delegation", async () => {
    build([
      [
        User,
        repo("users", {
          findOne: () => ({
            id: OWNER_ID,
            firstName: "Owner",
            lastName: "Name",
            isDelegateOnly: true,
          }),
        }),
      ],
      [
        AccountDelegate,
        repo("delegations", {
          find: [
            {
              id: DELEGATION_ID,
              ownerUserId: OWNER_ID,
              delegateUserId: DELEGATE_ID,
              billsCanRead: true,
            },
          ],
        }),
      ],
      [AccountDelegateGrant, repo("grants", { find: [] })],
      [Account, repo("accounts", { exists: false })],
      [UserPreference, repo("prefs", { findOne: null })],
    ]);

    const contexts = await withUserContext(DELEGATE_ID, () =>
      service.getAvailableContexts(DELEGATE_ID),
    );

    // As `relations: ["owner"]` this joined to nothing under enforcement and
    // the switcher offered the delegate a raw UUID to click on.
    expect(contexts).toEqual([
      {
        userId: OWNER_ID,
        label: "Owner Name",
        isSelf: false,
        ownerHas2FA: false,
      },
    ]);
    expect(identities().some((line) => line.endsWith(": bypass"))).toBe(false);
    expect(gucs()).not.toContain(BYPASS_SQL);
  });
});
