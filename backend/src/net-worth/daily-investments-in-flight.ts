import { getActiveScopedManager } from "../common/db/scoped-db";
import { getRequestContext } from "../common/request-context";

/**
 * One daily investment valuation per identical question, while it is running.
 *
 * Opening the Investments page asks for the same day-by-day valuation from
 * several requests at once: the "Portfolio performance" batch values the
 * scope from the day before its first transaction, and so does the value
 * chart on its All range. Node runs each of those walks on the one event loop,
 * so two copies of a since-inception fold are twice the time every other
 * request on the page waits behind; on a portfolio with decades of history
 * that put all of them past the client's timeout (issue #1888).
 *
 * This holds the *in-flight promise only*. A caller that arrives while an
 * identical valuation is running shares it; the entry is dropped the moment it
 * settles, so nothing is ever answered from a finished computation and there
 * is no TTL to go stale. What it can still serve late is bounded by the
 * computation itself, and the write seams that drop the portfolio summary memo
 * drop these entries too (`invalidatePortfolioSummary` and the replica
 * broadcast), so a read that starts after a committed write starts a valuation
 * of its own rather than joining one that began before it.
 *
 * The key is every input that can change the answer, resolved: the window's
 * two dates, the account scope, the reporting currency, whether positions are
 * collected, whether the read may fetch missing rates, and the ambient
 * identity and timezone the reads run under. A caller inside a transaction
 * never shares in either direction: its reads see its own uncommitted rows,
 * which no other request may be answered from.
 */

interface InFlightEntry {
  readonly userId: string;
  readonly value: Promise<unknown>;
}

class DailyInvestmentsInFlight {
  private readonly entries = new Map<string, InFlightEntry>();

  /**
   * Join the valuation running under `key`, or start `compute` and let every
   * caller that arrives before it settles share it.
   */
  run<T>(userId: string, key: string, compute: () => Promise<T>): Promise<T> {
    if (getActiveScopedManager()) return compute();
    const existing = this.entries.get(key);
    if (existing) return existing.value as Promise<T>;

    const value = compute();
    const entry: InFlightEntry = { userId, value };
    this.entries.set(key, entry);
    const settle = () => {
      // Only this entry: an invalidation may already have replaced it.
      if (this.entries.get(key) === entry) this.entries.delete(key);
    };
    value.then(settle, settle);
    return value;
  }

  /** Stop sharing a user's running valuations with later callers. */
  invalidateUser(userId: string): void {
    for (const [key, entry] of this.entries) {
      if (entry.userId === userId) this.entries.delete(key);
    }
  }

  /** Stop sharing every running valuation (whole-dataset events, tests). */
  clearAll(): void {
    this.entries.clear();
  }

  /** Running entries, for the specs. */
  get size(): number {
    return this.entries.size;
  }
}

/**
 * The process-wide registry. A module-level singleton, like the portfolio
 * summary memo, so the write seams that invalidate that memo reach it without
 * a constructor dependency on the net-worth module.
 */
export const dailyInvestmentsInFlight = new DailyInvestmentsInFlight();

/** The resolved inputs a daily valuation's answer depends on. */
export interface DailyInvestmentsKeyInput {
  userId: string;
  startDate: string | undefined;
  endDate: string;
  accountIds: string[] | undefined;
  currency: string;
  collectPositions: boolean;
  fetchMissing: boolean | undefined;
}

/** The share key; see the module comment for why each part is in it. */
export function buildDailyInvestmentsKey(
  input: DailyInvestmentsKeyInput,
): string {
  const ctx = getRequestContext();
  const identity = ctx?.system
    ? "system"
    : `${ctx?.userId ?? "-"}:${ctx?.realUserId ?? "-"}`;
  const scope =
    input.accountIds && input.accountIds.length > 0
      ? [...input.accountIds].sort().join(",")
      : "all";
  return JSON.stringify([
    input.userId,
    input.startDate ?? "inception",
    input.endDate,
    scope,
    input.currency,
    input.collectPositions,
    input.fetchMissing === false ? "stored" : "fill",
    identity,
    ctx?.timezone ?? "-",
  ]);
}
