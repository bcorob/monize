import { AsyncLocalStorage } from "node:async_hooks";
import { DataSource, EntityManager } from "typeorm";
import { getRequestContext, RequestContext } from "../request-context";
import { getRlsMode } from "./rls-config";

/**
 * The single sanctioned door to the database under Row-Level Security.
 *
 * `withScopedDb` opens a transaction, sets the identity GUC transaction-locally
 * (`set_config(..., true)`, i.e. `SET LOCAL` semantics) as its first statement,
 * and runs `fn` with the transaction's EntityManager. Because the GUC dies with
 * the transaction, no pooled connection can ever carry a prior request's
 * identity -- there is no reset code, no release hook. See the RLS design doc,
 * Phase 2b.
 *
 * It **throws** when no ambient context exists: a silent fallback to
 * `dataSource.manager` would run a query with no GUC under enforcement (zero
 * rows that look exactly like empty data). Refusing instead moves that whole
 * failure class to dev/CI at `RLS_MODE=off`, long before enforcement.
 *
 * The "scope" is whatever identity `withUserContext`/`withSystemContext` (or the
 * RequestContextInterceptor) put in the ambient context: those establish an
 * identity, this spends it on a database handle. Formerly named `tenantTx` --
 * older commits, the 1.13.0 release note and migration 107 still say that.
 */

// The active transaction's EntityManager, carried in its own ALS scope so a
// nested withScopedDb can join the ambient transaction instead of opening a
// second one. A second `dataSource.transaction` would take a second pooled
// connection inside the first and deadlock the pool under load (design 2b).
//
// The identity that opened the transaction travels with it. The GUCs are set
// once, as the transaction's first statement, and are transaction-local -- so a
// nested call that joins under a *different* ambient identity gets the outer
// transaction's GUCs regardless of what its own context says. That silently
// disagrees with the application's belief about who it is acting as (DR-01):
// usually it fails closed or writes to the outer identity, but a caller that
// uses the nested identity for a non-database decision is then wrong, and a
// nested `withSystemContext` reads as an escape hatch that does not escape.
// Recording the identity here is what lets the join refuse instead.
interface ActiveTransaction {
  manager: EntityManager;
  identity: TransactionIdentity;
}

const activeManagerStorage = new AsyncLocalStorage<ActiveTransaction>();

export function getActiveScopedManager(): EntityManager | undefined {
  return activeManagerStorage.getStore()?.manager;
}

/**
 * The identity a transaction's GUCs were set from -- exactly the fields
 * `withScopedDb` turns into `set_config` calls, normalized so two contexts that
 * produce identical GUCs compare equal.
 */
interface TransactionIdentity {
  system: boolean;
  currentUserId?: string;
  realUserId?: string;
  preserveTimestamps: boolean;
}

function identityOf(ctx: RequestContext): TransactionIdentity {
  return ctx.system
    ? // A system transaction emits only app.bypass_rls, so a userId in the
      // context is not part of the transaction's identity and must not make two
      // otherwise identical system scopes compare unequal.
      { system: true, preserveTimestamps: !!ctx.preserveTimestamps }
    : {
        system: false,
        currentUserId: ctx.userId,
        // `withScopedDb` defaults the real user to the current one, so a context
        // that omits it is the same identity as one that spells it out.
        realUserId: ctx.realUserId ?? ctx.userId,
        preserveTimestamps: !!ctx.preserveTimestamps,
      };
}

function describeIdentity(identity: TransactionIdentity): string {
  const parts = identity.system
    ? ["system bypass"]
    : [
        `current=${identity.currentUserId}`,
        `real=${identity.realUserId ?? identity.currentUserId}`,
      ];
  if (identity.preserveTimestamps) parts.push("preserveTimestamps");
  return parts.join(", ");
}

function sameIdentity(a: TransactionIdentity, b: TransactionIdentity): boolean {
  return (
    a.system === b.system &&
    a.currentUserId === b.currentUserId &&
    a.realUserId === b.realUserId &&
    a.preserveTimestamps === b.preserveTimestamps
  );
}

/**
 * Run `fn` while `manager` is registered as the ambient transaction. Exported
 * for tests and for advanced callers that already hold a manager; ordinary code
 * should use `withScopedDb`.
 *
 * The registered identity defaults to the current ambient context, which is what
 * `withScopedDb` passes and what a test double wants.
 */
export function runWithActiveScopedManager<T>(
  manager: EntityManager,
  fn: () => T,
  identity: TransactionIdentity = identityOf(getRequestContext() ?? {}),
): T {
  return activeManagerStorage.run({ manager, identity }, fn);
}

/**
 * Run `fn` with no ambient transaction, so a `withScopedDb` inside it opens its
 * **own** transaction on its own connection instead of joining the caller's.
 *
 * This is the deliberate exception to the re-entrancy rule above, and it exists
 * for one shape: a long write that has to publish progress a concurrent reader
 * can see. A row written inside the outer transaction is invisible until commit,
 * so a wizard polling an import job would watch a frozen progress bar for three
 * minutes. See the `.mny` import job service (design ADR-3).
 *
 * It costs one extra pooled connection for the duration of the inner call, which
 * is why it is only ever correct for a small, short statement at a phase
 * boundary -- never per row, and never for another long transaction. Used in a
 * loop it would reproduce exactly the pool exhaustion the nesting rule prevents.
 */
export function runOutsideActiveScopedManager<T>(fn: () => T): T {
  return activeManagerStorage.exit(fn);
}

export const IDENTITY_MISMATCH_MESSAGE =
  "withScopedDb cannot change identity while joining an ambient transaction";

export const MISSING_CONTEXT_MESSAGE =
  "DB access outside request/user/system context -- wrap the call path in withUserContext/withSystemContext";

/**
 * Isolation levels callers may request. Two paths need one: registration
 * (SERIALIZABLE, to close the first-user-admin race) and the backup export
 * (REPEATABLE READ, so every table in one file comes from the same snapshot --
 * `BackupExportService.inExportSnapshot`). Everything else uses the connection
 * default, exactly as before.
 *
 * Spelled out rather than imported from `typeorm/driver/types/IsolationLevel`:
 * that deep path type-checks under tsc but does not resolve under ts-jest, so
 * importing it takes every suite in the repo down.
 */
export type ScopedDbIsolation =
  "READ UNCOMMITTED" | "READ COMMITTED" | "REPEATABLE READ" | "SERIALIZABLE";

export async function withScopedDb<T>(
  dataSource: DataSource,
  fn: (manager: EntityManager) => Promise<T>,
  isolation?: ScopedDbIsolation,
): Promise<T> {
  const ctx = getRequestContext();
  if (!ctx || (!ctx.userId && !ctx.system)) {
    throw new Error(MISSING_CONTEXT_MESSAGE);
  }

  const active = activeManagerStorage.getStore();
  if (active) {
    const wanted = identityOf(ctx);
    if (!sameIdentity(active.identity, wanted)) {
      // Joining would run `fn` under the OUTER transaction's GUCs while the
      // caller believes it changed identity. Refuse instead: whichever of the
      // two the code meant, one of them is not what the database is doing.
      // Genuinely needing a different identity means a separate transaction --
      // `runOutsideActiveScopedManager` -- and that is a decision to make
      // deliberately, because it is no longer atomic with the outer work.
      throw new Error(
        `${IDENTITY_MISMATCH_MESSAGE}: transaction opened with ` +
          `[${describeIdentity(active.identity)}], nested call wants ` +
          `[${describeIdentity(wanted)}]`,
      );
    }
    if (isolation) {
      // A joined transaction already has an isolation level, chosen by whoever
      // opened it. Silently downgrading a SERIALIZABLE request to whatever the
      // caller happened to be running under would reintroduce exactly the race
      // the caller asked to prevent, invisibly -- so refuse instead.
      throw new Error(
        `withScopedDb cannot apply isolation "${isolation}": it is joining an ambient transaction`,
      );
    }
    // Re-entrant call under the same identity: join the ambient transaction
    // (same connection, same GUCs, same atomicity). Never open a second one.
    return fn(active.manager);
  }

  const runInTransaction = async (manager: EntityManager) => {
    const mode = getRlsMode();
    if (mode !== "off") {
      if (ctx.system) {
        // Privileged escape hatch -- policies OR in app_bypass_rls().
        await manager.query("SELECT set_config('app.bypass_rls', 'on', true)");
      } else {
        // Both identity GUCs. `real` defaults to `current` outside delegation.
        await manager.query(
          "SELECT set_config('app.current_user_id', $1, true)",
          [ctx.userId],
        );
        await manager.query("SELECT set_config('app.real_user_id', $1, true)", [
          ctx.realUserId ?? ctx.userId,
        ]);
      }
    }

    if (ctx.preserveTimestamps) {
      // NOT gated on the RLS mode: this replaces the backup restore path's old
      // `DISABLE TRIGGER` DDL and must work in every mode (including `off`) once
      // the GUC-aware `updated_at` trigger has shipped (migration M1).
      await manager.query(
        "SELECT set_config('app.preserve_timestamps', 'on', true)",
      );
    }

    return runWithActiveScopedManager(
      manager,
      () => fn(manager),
      identityOf(ctx),
    );
  };

  return isolation
    ? dataSource.transaction(isolation, runInTransaction)
    : dataSource.transaction(runInTransaction);
}
