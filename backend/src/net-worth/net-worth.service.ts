import { Injectable, Logger } from "@nestjs/common";
import { Cron, CronExpression } from "@nestjs/schedule";
import { DataSource, In, LessThanOrEqual } from "typeorm";
import {
  runOutsideActiveScopedManager,
  withScopedDb,
} from "../common/db/scoped-db";
import { lockAccountsForBalanceWrite } from "../common/db/locks";
import { withSystemContext, withUserContext } from "../common/db/with-context";
import { MonthlyAccountBalance } from "./entities/monthly-account-balance.entity";
import {
  Account,
  AccountType,
  AccountSubType,
} from "../accounts/entities/account.entity";
import { NON_VOID_INVESTMENT_STATUS } from "../securities/investment-row-effects.util";
import { InvestmentTransaction } from "../securities/entities/investment-transaction.entity";
import {
  baseInvestmentAction,
  MARKET_PRICED_TRADE_ACTIONS,
} from "../securities/investment-replay.util";
import { Security } from "../securities/entities/security.entity";
import { UserPreference } from "../users/entities/user-preference.entity";
import { convertWithRateLookup } from "../common/currency-conversion.util";
import { FxAggregate } from "../common/fx-aggregate";
import { applyActionToQuantity } from "../securities/investment-replay.util";
import { formatDateYMDLocal } from "../common/date-utils";
import { positionCloseAsOf, PricePoint } from "./position-price.util";

const LIABILITY_TYPES: AccountType[] = [
  AccountType.CREDIT_CARD,
  AccountType.LOAN,
  AccountType.MORTGAGE,
  AccountType.LINE_OF_CREDIT,
];

type RateIndex = Map<string, Array<{ date: string; rate: number }>>;

/**
 * Joint accounts to include in a grantee's net worth (joint-accounts spec,
 * N1). Built by the HTTP controller from the caller's active joint grants
 * MINUS their delegate_net_worth_exclusions -- inclusion here IS the
 * authorization and the preference, so the service applies no further
 * filtering (in particular, the OWNER's exclude_from_net_worth flag governs
 * the owner's view only and is deliberately not consulted for these rows).
 * Absent (undefined) everywhere else -- AI tools, internal calls -- which
 * keeps every existing path byte-identical.
 */
export interface JointNetWorthScope {
  accounts: Array<{ accountId: string; ownerUserId: string }>;
}

export type InvestmentBreakdownGranularity = "daily" | "monthly";

/**
 * One stacked band on the Portfolio Value Over Time "by security" chart. A
 * band is either an individual held security, the rolled-up "other" bucket of
 * smaller holdings beyond the top-N cutoff, or the aggregate cash band. Only
 * securities carry `symbol`/`name`; `cash` and `other` are labelled on the
 * client so their copy stays localized.
 */
export interface InvestmentBreakdownSeries {
  /** securityId for a real holding, or the sentinel "cash" / "other". */
  key: string;
  type: "security" | "cash" | "other";
  symbol: string | null;
  name: string;
}

export interface InvestmentBreakdownPoint {
  /** YYYY-MM-DD; the month-first date for monthly granularity. */
  date: string;
  /** Sum of every band's value at this point (in the display currency). */
  total: number;
  /** Per-series value keyed by {@link InvestmentBreakdownSeries.key}. */
  values: Record<string, number>;
}

export interface InvestmentBreakdown {
  granularity: InvestmentBreakdownGranularity;
  currency: string;
  series: InvestmentBreakdownSeries[];
  points: InvestmentBreakdownPoint[];
  /**
   * False when at least one component could not be converted into `currency`
   * because no exchange rate was available for its pair, which makes every
   * `total` here a subtotal of what did convert.
   *
   * A missing rate used to be applied as 1:1, so a consumer had no way to tell
   * a complete figure from a wrong one (audit P5-009). See
   * `docs/specs/fx-conversion-completeness.md` -- stage 2 makes the totals
   * themselves nullable.
   */
  fxComplete: boolean;
  /** `"USD->EUR"` for each pair with no available rate; empty when complete. */
  missingRatePairs: string[];
}

@Injectable()
export class NetWorthService {
  private readonly logger = new Logger(NetWorthService.name);
  private readonly recalcTimers = new Map<
    string,
    ReturnType<typeof setTimeout>
  >();
  private static readonly RECALC_DEBOUNCE_MS = 2000;

  /**
   * How long a snapshot may lag its account's last change before the sweep
   * recomputes it -- measured from the change to *now*, not from the change to
   * the previous snapshot.
   *
   * The distinction is load-bearing (review MZ-1242-R5). The sweep fires when
   * `a.updated_at > s.computed_at AND a.updated_at <= NOW() - grace`: the
   * account changed after its snapshot, and that change is now older than the
   * grace, so the debounce timer had ample time and clearly did not run.
   * Expressing the grace as a required distance *between the change and the old
   * snapshot* instead (`a.updated_at > s.computed_at + grace`) is a permanent
   * blind spot: a change one minute after the snapshot never satisfies it, so a
   * lost debounce for a manual-price edit -- which moves no balance and touches
   * only `updated_at` -- would never be recovered.
   *
   * The grace is comfortably longer than the debounce plus a slow recalc, so
   * the sweep does not race the timer that is about to do the same work, and
   * repeated edits keep pushing `updated_at` forward so it waits until the most
   * recent change has settled.
   */
  private static readonly STALE_SNAPSHOT_GRACE_MS = 10 * 60 * 1000;

  /** Accounts recomputed per sweep, so a broken deployment cannot melt the pool. */
  private static readonly STALE_SWEEP_BATCH = 200;

  constructor(private dataSource: DataSource) {}

  /**
   * One raw statement in its own short scoped transaction -- the RLS-compliant
   * equivalent of the autocommit `dataSource.query` this service used before
   * the migration. Reporting reads here are independent single statements, so
   * each gets its own tenant transaction rather than one long-held connection.
   */
  private scopedQuery<T = any>(sql: string, params?: any[]): Promise<T> {
    return withScopedDb(this.dataSource, (m) => m.query(sql, params));
  }

  /**
   * Debounced trigger for recalculating a single account's net worth snapshots.
   *
   * The timer lives in this process's memory, so it is a latency optimization and
   * nothing more: a pod killed in the two seconds before it fires, or a recalc
   * that throws, loses the work with only a `warn` to show for it, and the
   * snapshots then disagree with the ledger until something else happens to
   * touch the account (audit DR-04-03). `sweepStaleSnapshots` is what makes that
   * recoverable -- it finds the disagreement in the data rather than needing a
   * queue entry that the same crash would have lost.
   */
  triggerDebouncedRecalc(accountId: string, userId: string): void {
    const key = `${userId}:${accountId}`;
    const existing = this.recalcTimers.get(key);
    if (existing) clearTimeout(existing);

    // Several callers trigger this from *inside* a `withScopedDb` block (see
    // TransactionSplitService.createSplits). A timer created there would
    // inherit that block's EntityManager through the scoped-manager ALS, and
    // fire seconds later -- long after the transaction committed and its
    // connection went back to the pool -- so every query in the recalc would
    // run on a dead manager. Registering the timer outside the active manager
    // makes the recalc open its own transaction, which is what it wants
    // anyway: it is a background job, not part of the caller's write. The
    // identity context (userId) lives in a different ALS and is preserved.
    runOutsideActiveScopedManager(() =>
      this.recalcTimers.set(
        key,
        setTimeout(() => {
          this.recalcTimers.delete(key);
          this.recalculateAccount(userId, accountId).catch((err) =>
            this.logger.warn(
              `Net worth recalc failed for account ${accountId}: ${err.message}`,
            ),
          );
        }, NetWorthService.RECALC_DEBOUNCE_MS),
      ),
    );
  }

  async recalculateAccount(userId: string, accountId: string): Promise<void> {
    await withScopedDb(this.dataSource, async (m) => {
      // The lock first, then every read the snapshots are derived from, then the
      // delete-and-reinsert -- all in this transaction.
      //
      // Previously the monthly sums were read in one autocommit transaction and
      // written in another. Under READ COMMITTED that is two statement snapshots:
      // a transaction committing between them produced snapshots that did not
      // include it, permanently, until something else triggered a recalc. Two
      // concurrent recalcs of the same account were worse -- whichever wrote
      // second won, and it might be the one that read first, so the newer data
      // lost. Same protocol as every other absolute recomputation here: advisory
      // and row locks before the read they protect (see common/db/locks.ts).
      await lockAccountsForBalanceWrite(m, [accountId], userId);

      const account = await m.getRepository(Account).findOne({
        where: { id: accountId, userId },
      });
      if (!account) return;

      await this.recalculateLockedAccount(userId, account);
    });
  }

  /**
   * Recompute snapshots that no longer agree with their account.
   *
   * The debounce timer is process memory, so every way it can be lost -- a pod
   * killed inside the two-second window, a recalc that throws, a rolling deploy
   * -- leaves snapshots that disagree with the ledger and nothing that will ever
   * notice. A durable work queue would not help: the crash that loses the timer
   * loses the enqueue too, unless the enqueue joins the caller's transaction, and
   * then every write path has to know about net worth.
   *
   * So the staleness is *derived* rather than recorded. Every write that can
   * change a snapshot also touches the account row in the same transaction --
   * usually a `current_balance` delta, and for the one snapshot-only change that
   * moves no balance (a past-dated row shifted to another past month, so the
   * running total is unchanged) an explicit `AccountsService.touchAccount`.
   * Either way `accounts.updated_at` advances, so it is a timestamp the account
   * itself keeps -- and the snapshots are a delete-and-reinsert, so their
   * `updated_at` is when they were last computed. An account whose row is newer
   * than its own snapshots, and whose change is now older than the grace
   * period, was missed (see `STALE_SNAPSHOT_GRACE_MS` for why the grace is an
   * age of the change, not a distance from the old snapshot -- MZ-1242-R5).
   *
   * This is the idempotent-predicate mechanism from `docs/cron-jobs.md`: two
   * replicas racing the sweep recompute the same accounts from scratch, under the
   * per-account lock, and the loser's work is simply redundant. Accounts with no
   * snapshots at all are deliberately not swept -- there is nothing to compare
   * against, and including them would recompute every empty account forever.
   */
  @Cron(CronExpression.EVERY_30_MINUTES)
  async sweepStaleSnapshots(): Promise<void> {
    try {
      const stale = await withSystemContext(() =>
        withScopedDb(this.dataSource, (m) =>
          m.query(
            `SELECT a.user_id, a.id AS account_id
               FROM accounts a
               JOIN (
                 SELECT account_id, MAX(updated_at) AS computed_at
                   FROM monthly_account_balances
                  GROUP BY account_id
               ) s ON s.account_id = a.id
              WHERE a.updated_at > s.computed_at
                AND a.updated_at <= NOW() - ($1::text || ' milliseconds')::interval
              ORDER BY a.updated_at
              LIMIT $2`,
            [
              String(NetWorthService.STALE_SNAPSHOT_GRACE_MS),
              NetWorthService.STALE_SWEEP_BATCH,
            ],
          ),
        ),
      );

      if (stale.length === 0) return;

      this.logger.log(
        `Recomputing ${stale.length} account(s) whose net-worth snapshots fell behind`,
      );
      if (stale.length === NetWorthService.STALE_SWEEP_BATCH) {
        // Say so rather than letting a truncated pass read as "all caught up".
        this.logger.warn(
          `Stale snapshot sweep hit its batch limit of ${NetWorthService.STALE_SWEEP_BATCH}; more remain for the next pass`,
        );
      }

      for (const row of stale as Array<{
        user_id: string;
        account_id: string;
      }>) {
        try {
          await withUserContext(row.user_id, () =>
            this.recalculateAccount(row.user_id, row.account_id),
          );
        } catch (err) {
          this.logger.warn(
            `Stale snapshot recompute failed for account ${row.account_id}: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        }
      }
    } catch (err) {
      this.logger.warn(
        `Stale snapshot sweep failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  /**
   * Dispatch for an account whose row is already locked inside the ambient
   * transaction. The two branches' own `withScopedDb`/`scopedQuery` calls join it.
   */
  private async recalculateLockedAccount(
    userId: string,
    account: Account,
  ): Promise<void> {
    if (this.isBrokerageOrStandaloneInvestment(account)) {
      await this.recalculateBrokerageAccount(userId, account);
    } else {
      await this.recalculateRegularAccount(userId, account);
    }
  }

  async recalculateAllAccounts(userId: string): Promise<void> {
    // Include closed accounts - they have important historical balances
    const accounts = await withScopedDb(this.dataSource, (m) =>
      m.getRepository(Account).find({
        where: { userId },
      }),
    );
    await Promise.all(
      accounts.map(async (account) => {
        try {
          // One locked transaction per account, exactly as the single-account
          // path: a full-user rebuild racing an ordinary edit must not write a
          // snapshot derived from rows that changed while it was reading.
          await this.recalculateAccount(userId, account.id);
        } catch (err) {
          this.logger.warn(
            `Failed to recalculate account ${account.id}: ${err.message}`,
          );
        }
      }),
    );
  }

  async ensurePopulated(userId: string): Promise<void> {
    const count = await withScopedDb(this.dataSource, (m) =>
      m.getRepository(MonthlyAccountBalance).count({ where: { userId } }),
    );
    if (count === 0) {
      await this.recalculateAllAccounts(userId);
      return;
    }

    await this.refreshStaleAccountsForCurrentMonth(userId);
  }

  /**
   * Per-account recalc is debounced and only runs when an account's
   * transactions change. When the calendar rolls into a new month, accounts
   * that haven't been touched still have snapshots ending in the previous
   * month, so they don't contribute to the new month's aggregate -- causing
   * the chart to drop to whatever subset of accounts had a transaction post
   * since the month rolled over. Detect those stale accounts and refresh them.
   */
  private async refreshStaleAccountsForCurrentMonth(
    userId: string,
  ): Promise<void> {
    const now = new Date();
    const currentMonthStr = `${now.getFullYear()}-${String(
      now.getMonth() + 1,
    ).padStart(2, "0")}-01`;

    const accounts = await withScopedDb(this.dataSource, (m) =>
      m.getRepository(Account).find({
        where: { userId },
        select: ["id"],
      }),
    );
    if (accounts.length === 0) return;

    const populated = await withScopedDb(this.dataSource, (m) =>
      m.getRepository(MonthlyAccountBalance).find({
        where: { userId, month: currentMonthStr },
        select: ["accountId"],
      }),
    );
    const populatedIds = new Set(populated.map((p) => p.accountId));

    const staleIds = accounts
      .map((a) => a.id)
      .filter((id) => !populatedIds.has(id));
    if (staleIds.length === 0) return;

    await Promise.all(
      staleIds.map((id) =>
        this.recalculateAccount(userId, id).catch((err) =>
          this.logger.warn(
            `Failed to refresh stale net worth for account ${id}: ${err.message}`,
          ),
        ),
      ),
    );
  }

  /**
   * Joint accounts' snapshots are owner-maintained, so ensurePopulated
   * (keyed to the caller) never refreshes them: when the calendar rolls into
   * a new month before the owner's next recalc, the grantee's chart would
   * silently drop the joint account from the current month. Refresh each
   * stale joint account under ITS OWNER's context -- identity-correct writes
   * (mab rows carry the owner's user_id) that both users then see.
   */
  private async refreshStaleJointMonths(
    scope: JointNetWorthScope,
  ): Promise<void> {
    const now = new Date();
    const currentMonthStr = `${now.getFullYear()}-${String(
      now.getMonth() + 1,
    ).padStart(2, "0")}-01`;

    const ids = scope.accounts.map((a) => a.accountId);
    // Readable in the grantee's session (migration-134 arm at enforcement).
    const populated = await withScopedDb(this.dataSource, (m) =>
      m.getRepository(MonthlyAccountBalance).find({
        where: { accountId: In(ids), month: currentMonthStr },
        select: ["accountId"],
      }),
    );
    const populatedIds = new Set(populated.map((p) => p.accountId));

    const stale = scope.accounts.filter((a) => !populatedIds.has(a.accountId));
    await Promise.all(
      stale.map(({ accountId, ownerUserId }) =>
        withUserContext(ownerUserId, () =>
          this.recalculateAccount(ownerUserId, accountId),
        ).catch((err) =>
          this.logger.warn(
            `Failed to refresh stale joint net worth for account ${accountId}: ${err.message}`,
          ),
        ),
      ),
    );
  }

  /**
   * Check if an account is a brokerage or standalone investment account
   * (i.e. an account that can hold securities and needs market value tracking)
   */
  private isBrokerageOrStandaloneInvestment(account: Account): boolean {
    return (
      account.accountSubType === AccountSubType.INVESTMENT_BROKERAGE ||
      (account.accountType === AccountType.INVESTMENT &&
        !account.accountSubType)
    );
  }

  /**
   * Recalculate monthly snapshots for all investment accounts that have holdings.
   * Called after security prices are refreshed to keep chart data in sync.
   */
  async recalculateAllInvestmentSnapshots(): Promise<void> {
    const accounts = await withScopedDb(this.dataSource, (m) =>
      m
        .getRepository(Account)
        .createQueryBuilder("a")
        .where("a.accountType = :type", { type: AccountType.INVESTMENT })
        .andWhere(
          "(a.accountSubType = :brokerage OR a.accountSubType IS NULL)",
          { brokerage: AccountSubType.INVESTMENT_BROKERAGE },
        )
        .getMany(),
    );

    await Promise.all(
      accounts.map(async (account) => {
        try {
          await this.recalculateBrokerageAccount(account.userId, account);
        } catch (err) {
          this.logger.warn(
            `Failed to recalculate investment snapshot for account ${account.id}: ${err.message}`,
          );
        }
      }),
    );
  }

  /**
   * Monthly net worth history shaped for LLM tools. Shared by the AI
   * Assistant and MCP `generate_report` tools (type `net_worth_history`) so
   * both surfaces return the same data with the same default range (last 12
   * months if no dates provided).
   */
  async getLlmHistory(
    userId: string,
    startDate?: string,
    endDate?: string,
  ): Promise<
    {
      month: string;
      assets: number;
      liabilities: number;
      netWorth: number;
      /**
       * False when a component of this month could not be converted into the
       * reporting currency, which makes the three figures above subtotals of
       * what did convert. A missing rate used to be applied as 1:1 (audit
       * P5-009); see docs/specs/fx-conversion-completeness.md.
       */
      fxComplete: boolean;
      /** `"JPY->USD"` for each pair with no available rate. */
      missingRatePairs: string[];
    }[]
  > {
    const today = new Date();
    const defaultStart = new Date(today.getFullYear() - 1, today.getMonth(), 1)
      .toISOString()
      .substring(0, 10);
    const resolvedStart = startDate || defaultStart;
    const resolvedEnd = endDate || today.toISOString().substring(0, 10);
    return this.getMonthlyNetWorth(userId, resolvedStart, resolvedEnd);
  }

  async getMonthlyNetWorth(
    userId: string,
    startDate?: string,
    endDate?: string,
    jointScope?: JointNetWorthScope,
  ): Promise<
    {
      month: string;
      assets: number;
      liabilities: number;
      netWorth: number;
      /**
       * False when a component of this month could not be converted into the
       * reporting currency, which makes the three figures above subtotals of
       * what did convert. A missing rate used to be applied as 1:1 (audit
       * P5-009); see docs/specs/fx-conversion-completeness.md.
       */
      fxComplete: boolean;
      /** `"JPY->USD"` for each pair with no available rate. */
      missingRatePairs: string[];
    }[]
  > {
    await this.ensurePopulated(userId);
    const jointIds = jointScope?.accounts.map((a) => a.accountId) ?? [];
    if (jointScope && jointIds.length > 0) {
      await this.refreshStaleJointMonths(jointScope);
    }

    const pref = await withScopedDb(this.dataSource, (m) =>
      m.getRepository(UserPreference).findOne({ where: { userId } }),
    );
    const defaultCurrency = pref?.defaultCurrency || "USD";

    const start = startDate || "1990-01-01";
    const end = endDate || new Date().toISOString().slice(0, 10);

    // Own rows keep the owner-side exclude_from_net_worth predicate; joint
    // rows are governed solely by the pre-filtered scope (see
    // JointNetWorthScope). One predicate for the series and (via
    // getLatestNetWorth) the latest month, so the two can never disagree.
    const snapshots: any[] = await this.scopedQuery(
      `SELECT mab.month, mab.balance, mab.market_value,
              a.id as account_id, a.account_type, a.account_sub_type, a.currency_code
       FROM monthly_account_balances mab
       JOIN accounts a ON a.id = mab.account_id
       WHERE ((mab.user_id = $1 AND a.exclude_from_net_worth = false)
              OR mab.account_id = ANY($4::UUID[]))
         AND mab.month >= DATE_TRUNC('month', $2::DATE)
         AND mab.month <= DATE_TRUNC('month', $3::DATE)
       ORDER BY mab.month`,
      [userId, start, end, jointIds],
    );

    if (snapshots.length === 0) return [];

    // Collect currencies that need conversion
    const currencies = new Set<string>();
    for (const s of snapshots) {
      if (s.currency_code !== defaultCurrency) {
        currencies.add(s.currency_code);
      }
    }

    const rateIndex = await this.buildRateIndex(
      currencies,
      defaultCurrency,
      start,
      end,
    );

    // Aggregate by month. Assets and liabilities each accumulate through an
    // FxAggregate so a month containing a component with no available rate
    // reports an unknown total instead of a plausible wrong one (P5-009).
    const monthMap = new Map<
      string,
      { assets: FxAggregate; liabilities: FxAggregate }
    >();

    for (const s of snapshots) {
      const monthKey = this.toDateString(s.month);

      if (!monthMap.has(monthKey)) {
        monthMap.set(monthKey, {
          assets: new FxAggregate(),
          liabilities: new FxAggregate(),
        });
      }
      const entry = monthMap.get(monthKey)!;

      // For brokerage accounts: use market_value (holdings only; cash is in linked account)
      // For standalone investment accounts: use market_value + balance (holdings + cash)
      // For all others: use balance
      let rawValue: number;
      if (
        s.account_sub_type === "INVESTMENT_BROKERAGE" &&
        s.market_value != null
      ) {
        rawValue = Number(s.market_value);
      } else if (
        s.account_type === "INVESTMENT" &&
        s.account_sub_type === null &&
        s.market_value != null
      ) {
        rawValue = Number(s.market_value) + Number(s.balance);
      } else {
        rawValue = Number(s.balance);
      }

      // Compute month-end date for rate lookup
      const monthEnd = this.monthEndDate(monthKey);
      const converted = this.convertCurrency(
        rawValue,
        s.currency_code,
        defaultCurrency,
        monthEnd,
        rateIndex,
      );

      const accountType = s.account_type as AccountType;
      if (LIABILITY_TYPES.includes(accountType)) {
        entry.liabilities.add(
          converted === null ? null : Math.abs(converted),
          s.currency_code,
          defaultCurrency,
        );
      } else {
        entry.assets.add(converted, s.currency_code, defaultCurrency);
      }
    }

    return Array.from(monthMap.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([month, data]) => {
        // Per docs/financial-calculation-contract.md section 1: the total is
        // null unless every component converted, the partial sum travels in a
        // separately named field, and the response says what is missing.
        const missingRatePairs = [
          ...new Set([
            ...data.assets.missingPairs,
            ...data.liabilities.missingPairs,
          ]),
        ].sort();
        return {
          month,
          assets: Math.round(data.assets.knownSubtotal),
          liabilities: Math.round(data.liabilities.knownSubtotal),
          netWorth: Math.round(
            data.assets.knownSubtotal - data.liabilities.knownSubtotal,
          ),
          // Stage 1 of docs/specs/fx-conversion-completeness.md: the three
          // figures above are the subtotal of what converted, and these two
          // fields say so. They are NOT yet nullable -- that is stage 2, with
          // the frontend and copy work it needs -- but a consumer can now tell
          // a complete total from a partial one, which it could not when a
          // missing rate silently became 1:1.
          fxComplete: missingRatePairs.length === 0,
          missingRatePairs,
        };
      });
  }

  /**
   * Latest-month net worth only. The account summary and the
   * `get_account_balances` tool need just the most recent month's
   * assets/liabilities/netWorth, not the whole series. Bounding the snapshot
   * query and rate index to a single month avoids replaying the entire
   * monthly_account_balances history just to read the last element. Returns
   * null when the user has no populated snapshots.
   */
  async getLatestNetWorth(
    userId: string,
    jointScope?: JointNetWorthScope,
  ): Promise<{ assets: number; liabilities: number; netWorth: number } | null> {
    await this.ensurePopulated(userId);

    const jointIds = jointScope?.accounts.map((a) => a.accountId) ?? [];
    const latestRows: { month: string | Date }[] = await this.scopedQuery(
      `SELECT MAX(month) AS month FROM monthly_account_balances
        WHERE user_id = $1 OR account_id = ANY($2::UUID[])`,
      [userId, jointIds],
    );
    const latestMonth = latestRows[0]?.month;
    if (!latestMonth) return null;

    const monthStr = this.toDateString(latestMonth);
    const months = await this.getMonthlyNetWorth(
      userId,
      monthStr,
      monthStr,
      jointScope,
    );
    const latest = months[months.length - 1];
    if (!latest) return null;
    return {
      assets: latest.assets,
      liabilities: latest.liabilities,
      netWorth: latest.netWorth,
    };
  }

  async getMonthlyInvestments(
    userId: string,
    startDate?: string,
    endDate?: string,
    accountIds?: string[],
    displayCurrency?: string,
  ): Promise<
    {
      month: string;
      value: number;
      /** False when a component could not be converted; see missingRatePairs. */
      fxComplete: boolean;
      /** `"USD->EUR"` for each pair with no available rate. */
      missingRatePairs: string[];
    }[]
  > {
    await this.ensurePopulated(userId);

    const pref = await withScopedDb(this.dataSource, (m) =>
      m.getRepository(UserPreference).findOne({ where: { userId } }),
    );
    const defaultCurrency = displayCurrency || pref?.defaultCurrency || "USD";

    const start = startDate || "1990-01-01";
    const end = endDate || new Date().toISOString().slice(0, 10);

    let accountFilter = "";
    const params: any[] = [userId, start, end];

    if (accountIds && accountIds.length > 0) {
      // Resolve the requested accounts plus their linked pairs in one query
      // (an account, anything linked to it, and the account it links to)
      // instead of one round-trip per id.
      const resolved: { id: string }[] = await this.scopedQuery(
        `SELECT id FROM accounts
         WHERE user_id = $2
           AND (
             id = ANY($1)
             OR linked_account_id = ANY($1)
             OR id IN (
               SELECT linked_account_id FROM accounts
               WHERE id = ANY($1) AND user_id = $2
             )
           )`,
        [accountIds, userId],
      );
      const idArray = [...new Set(resolved.map((a) => a.id))];
      if (idArray.length === 0) {
        // No matching accounts found — return empty result
        return [];
      }
      // Build parameterized IN clause
      const placeholders = idArray.map((_, i) => `$${i + 4}`).join(", ");
      accountFilter = `AND a.id IN (${placeholders})`;
      params.push(...idArray);
    } else {
      accountFilter = `AND (a.account_sub_type IN ('INVESTMENT_CASH', 'INVESTMENT_BROKERAGE') OR (a.account_type = 'INVESTMENT' AND a.account_sub_type IS NULL))`;
    }

    const snapshots: any[] = await this.scopedQuery(
      `SELECT mab.month, mab.balance, mab.market_value,
              a.id as account_id, a.account_type, a.account_sub_type, a.currency_code
       FROM monthly_account_balances mab
       JOIN accounts a ON a.id = mab.account_id
       WHERE mab.user_id = $1
         AND mab.month >= DATE_TRUNC('month', $2::DATE)
         AND mab.month <= DATE_TRUNC('month', $3::DATE)
         ${accountFilter}
       ORDER BY mab.month`,
      params,
    );

    if (snapshots.length === 0) return [];

    // For the first active month of an account, the stored market_value is the
    // month-end snapshot which silently absorbs any gains/losses on positions
    // that were established earlier the same month -- skewing the chart's
    // change column. Replace that first-month market_value with a cost-basis
    // computed from the in-month brokerage transactions so the starting point
    // reflects the actual net invested.
    const firstMonthCostBasisInDefault =
      await this.computeFirstActiveMonthCostBasis(
        userId,
        snapshots,
        defaultCurrency,
        start,
        end,
      );

    const currencies = new Set<string>();
    for (const s of snapshots) {
      if (s.currency_code !== defaultCurrency) {
        currencies.add(s.currency_code);
      }
    }

    const rateIndex = await this.buildRateIndex(
      currencies,
      defaultCurrency,
      start,
      end,
    );

    const monthMap = new Map<string, FxAggregate>();

    for (const s of snapshots) {
      const monthKey = this.toDateString(s.month);

      if (!monthMap.has(monthKey)) {
        monthMap.set(monthKey, new FxAggregate());
      }

      const monthEnd = this.monthEndDate(monthKey);
      const adjKey = `${s.account_id}:${monthKey}`;
      const costBasisInDefault = firstMonthCostBasisInDefault.get(adjKey);

      const monthAggregate = monthMap.get(monthKey)!;
      if (costBasisInDefault !== undefined) {
        // merge, not addConverted: the seed's gaps travel with its subtotal,
        // so an unconvertible first-month component marks the month incomplete.
        monthAggregate.merge(costBasisInDefault);
        // Standalone investment accounts hold cash inside the same account, so
        // include the month-end cash balance alongside the cost basis.
        if (s.account_type === "INVESTMENT" && s.account_sub_type === null) {
          monthAggregate.add(
            this.convertCurrency(
              Number(s.balance),
              s.currency_code,
              defaultCurrency,
              monthEnd,
              rateIndex,
            ),
            s.currency_code,
            defaultCurrency,
          );
        }
      } else {
        let rawValue: number;
        if (
          s.account_sub_type === "INVESTMENT_BROKERAGE" &&
          s.market_value != null
        ) {
          rawValue = Number(s.market_value);
        } else if (
          s.account_type === "INVESTMENT" &&
          s.account_sub_type === null &&
          s.market_value != null
        ) {
          rawValue = Number(s.market_value) + Number(s.balance);
        } else {
          rawValue = Number(s.balance);
        }

        monthAggregate.add(
          this.convertCurrency(
            rawValue,
            s.currency_code,
            defaultCurrency,
            monthEnd,
            rateIndex,
          ),
          s.currency_code,
          defaultCurrency,
        );
      }
    }

    return Array.from(monthMap.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([month, aggregate]) => ({
        month,
        value: Math.round(aggregate.knownSubtotal),
        fxComplete: aggregate.isComplete,
        missingRatePairs: aggregate.missingPairs,
      }));
  }

  /**
   * For each brokerage / standalone-investment account in `snapshots` whose
   * snapshot row coincides with that account's first-ever active month,
   * compute the net cost basis of all in-month investment transactions
   * converted to `defaultCurrency`. Returns a map keyed by
   * `${accountId}:${monthKey}` -> an `FxAggregate` carrying the converted
   * value *and* any conversion gaps, so a component the seed could not convert
   * marks the month incomplete instead of being dropped into a partial sum
   * that ships under `fxComplete: true`.
   */
  private async computeFirstActiveMonthCostBasis(
    userId: string,
    snapshots: any[],
    defaultCurrency: string,
    start: string,
    end: string,
  ): Promise<Map<string, FxAggregate>> {
    const result = new Map<string, FxAggregate>();

    const eligibleSnapshots = snapshots.filter((s) => {
      const isBrokerage = s.account_sub_type === "INVESTMENT_BROKERAGE";
      const isStandalone =
        s.account_type === "INVESTMENT" && s.account_sub_type === null;
      return isBrokerage || isStandalone;
    });
    if (eligibleSnapshots.length === 0) return result;

    const accountIds = [...new Set(eligibleSnapshots.map((s) => s.account_id))];

    const firstMonthRows: any[] = await this.scopedQuery(
      `SELECT account_id, MIN(month)::DATE as first_month
       FROM monthly_account_balances
       WHERE account_id = ANY($1::UUID[]) AND user_id = $2
       GROUP BY account_id`,
      [accountIds, userId],
    );
    const firstActiveMonth = new Map<string, string>();
    for (const r of firstMonthRows) {
      firstActiveMonth.set(r.account_id, this.toDateString(r.first_month));
    }

    const targetMonthByAccount = new Map<string, string>();
    for (const s of eligibleSnapshots) {
      const monthKey = this.toDateString(s.month);
      if (firstActiveMonth.get(s.account_id) === monthKey) {
        targetMonthByAccount.set(s.account_id, monthKey);
      }
    }
    if (targetMonthByAccount.size === 0) return result;

    const targetAccountIds = [...targetMonthByAccount.keys()];
    const txRows: any[] = await this.scopedQuery(
      `SELECT it.account_id, it.action, it.quantity, it.price, it.transaction_date,
              s.currency_code AS security_currency
       FROM investment_transactions it
       LEFT JOIN securities s ON s.id = it.security_id
       WHERE it.account_id = ANY($1::UUID[])
         AND it.price IS NOT NULL AND it.price > 0
         AND it.status != 'VOID'
         AND (it.action = ANY($2) OR it.action IN ('TRANSFER_IN', 'TRANSFER_OUT'))`,
      [targetAccountIds, MARKET_PRICED_TRADE_ACTIONS],
    );

    const adjCurrencies = new Set<string>();
    for (const r of txRows) {
      if (r.security_currency && r.security_currency !== defaultCurrency) {
        adjCurrencies.add(r.security_currency);
      }
    }
    const rateIndex =
      adjCurrencies.size > 0
        ? await this.buildRateIndex(adjCurrencies, defaultCurrency, start, end)
        : new Map();

    for (const r of txRows) {
      const targetMonth = targetMonthByAccount.get(r.account_id);
      if (!targetMonth) continue;
      const txDate = this.toDateString(r.transaction_date);
      if (txDate.substring(0, 7) !== targetMonth.substring(0, 7)) continue;

      const qty = Number(r.quantity) || 0;
      const price = Number(r.price) || 0;
      if (qty === 0 || price <= 0) continue;

      let signed: number;
      switch (baseInvestmentAction(r.action)) {
        case "BUY":
        case "REINVEST":
        case "TRANSFER_IN":
          signed = qty * price;
          break;
        case "SELL":
        case "TRANSFER_OUT":
          signed = -qty * price;
          break;
        default:
          continue;
      }

      const secCurrency = r.security_currency || defaultCurrency;
      const monthEnd = this.monthEndDate(targetMonth);
      const inDefault = this.convertCurrency(
        signed,
        secCurrency,
        defaultCurrency,
        monthEnd,
        rateIndex,
      );

      // A cost-basis component with no rate is recorded as a gap on the
      // month's aggregate rather than added at 1:1 -- or silently dropped: a
      // seed that skipped it left the month's value understated while the
      // response still said `fxComplete: true`, the exact "flag that does not
      // cover every total" shape the completeness contract forbids.
      const key = `${r.account_id}:${targetMonth}`;
      let aggregate = result.get(key);
      if (!aggregate) {
        aggregate = new FxAggregate();
        result.set(key, aggregate);
      }
      aggregate.add(inDefault, secCurrency, defaultCurrency);
    }

    return result;
  }

  /**
   * The first day on or after `onOrAfter` on which any security the scope holds
   * actually has a price -- a trading day for this portfolio, as opposed to a
   * calendar day.
   *
   * `getDailyInvestments` values *every* calendar day at the latest close at or
   * before it, which is what makes a chart continuous and what makes 1 January
   * plot the previous 31 December's close. A YTD chart asked to open on the
   * first trading day of the year therefore cannot find it in that series: a
   * carried-forward holiday and a genuinely flat session look identical there.
   * `security_prices` rows exist only for days a price was struck, so the
   * question is answerable here and nowhere else.
   *
   * Returns **null** when the scope holds nothing priced, rather than a
   * substituted date: the caller then keeps the calendar boundary it already
   * had, and no chart claims a trading day nobody observed.
   */
  async getFirstPricedDay(
    userId: string,
    onOrAfter: string,
    accountIds?: string[],
  ): Promise<{ date: string | null }> {
    const params: any[] = [userId, onOrAfter];
    let accountFilter = "";
    if (accountIds && accountIds.length > 0) {
      const placeholders = accountIds.map((_, i) => `$${i + 3}`).join(", ");
      accountFilter = `AND a.id IN (${placeholders})`;
      params.push(...accountIds);
    }

    const rows: Array<{ date: string | null }> = await this.scopedQuery(
      `SELECT MIN(sp.price_date)::TEXT AS date
         FROM security_prices sp
        WHERE sp.price_date >= $2::DATE
          AND sp.security_id IN (
                SELECT DISTINCT it.security_id
                  FROM investment_transactions it
                  JOIN accounts a ON a.id = it.account_id
                 WHERE a.user_id = $1
                   AND it.security_id IS NOT NULL
                   AND it.status != 'VOID'
                   AND it.transaction_date <= $2::DATE
                   ${accountFilter}
              )`,
      params,
    );
    return { date: rows[0]?.date ?? null };
  }

  async getDailyInvestments(
    userId: string,
    startDate?: string,
    endDate?: string,
    accountIds?: string[],
    displayCurrency?: string,
  ): Promise<
    {
      date: string;
      value: number;
      /** False when a component could not be converted; see missingRatePairs. */
      fxComplete: boolean;
      /** "USD->EUR" for each pair with no available rate. */
      missingRatePairs: string[];
    }[]
  > {
    const pref = await withScopedDb(this.dataSource, (m) =>
      m.getRepository(UserPreference).findOne({ where: { userId } }),
    );
    const defaultCurrency = displayCurrency || pref?.defaultCurrency || "USD";

    const end = endDate || new Date().toISOString().slice(0, 10);

    let accountFilter = "";
    const acctParams: any[] = [userId];

    if (accountIds && accountIds.length > 0) {
      // Resolve the requested accounts plus their linked pairs in one query
      // instead of one round-trip per id.
      const resolved: { id: string }[] = await this.scopedQuery(
        `SELECT id FROM accounts
         WHERE user_id = $2
           AND (
             id = ANY($1)
             OR linked_account_id = ANY($1)
             OR id IN (
               SELECT linked_account_id FROM accounts
               WHERE id = ANY($1) AND user_id = $2
             )
           )`,
        [accountIds, userId],
      );
      const idArray = [...new Set(resolved.map((a) => a.id))];
      if (idArray.length === 0) return [];
      const placeholders = idArray.map((_, i) => `$${i + 2}`).join(", ");
      accountFilter = `AND a.id IN (${placeholders})`;
      acctParams.push(...idArray);
    } else {
      accountFilter = `AND (a.account_sub_type IN ('INVESTMENT_CASH', 'INVESTMENT_BROKERAGE') OR (a.account_type = 'INVESTMENT' AND a.account_sub_type IS NULL))`;
    }

    // Get investment accounts in scope
    const investAccounts: any[] = await this.scopedQuery(
      `SELECT a.id, a.account_type, a.account_sub_type, a.currency_code, a.opening_balance
       FROM accounts a
       WHERE a.user_id = $1 ${accountFilter}`,
      acctParams,
    );

    if (investAccounts.length === 0) return [];

    // "All time" (no startDate) begins where the scope's own history begins.
    const start =
      startDate ||
      (await this.resolveInvestmentInception(
        investAccounts.map((a) => a.id),
        end,
      ));

    const brokerageIds = investAccounts
      .filter(
        (a) =>
          a.account_sub_type === "INVESTMENT_BROKERAGE" ||
          (a.account_type === "INVESTMENT" && !a.account_sub_type),
      )
      .map((a) => a.id);
    const cashIds = investAccounts
      .filter(
        (a) =>
          a.account_sub_type === "INVESTMENT_CASH" ||
          (a.account_type === "INVESTMENT" && !a.account_sub_type),
      )
      .map((a) => a.id);
    // Load investment transactions up to end date for holdings replay
    const invTxs: any[] =
      brokerageIds.length > 0
        ? await this.scopedQuery(
            `SELECT account_id, security_id, action, quantity, transaction_date
           FROM investment_transactions
           WHERE account_id = ANY($1::UUID[])
             AND transaction_date <= $2
             AND status != 'VOID'
           ORDER BY transaction_date ASC, created_at ASC`,
            [brokerageIds, end],
          )
        : [];

    // Collect security IDs and load prices for the date range
    const securityIds = [
      ...new Set(
        invTxs.filter((t: any) => t.security_id).map((t: any) => t.security_id),
      ),
    ];

    // Load securities for currency (skipPriceUpdates is NOT consulted for
    // valuation -- see loadValuationSeries / positionCloseAsOf, #1242).
    const securities =
      securityIds.length > 0
        ? await withScopedDb(this.dataSource, (m) =>
            m.getRepository(Security).findByIds(securityIds),
          )
        : [];
    const securityMap = new Map(securities.map((s) => [s.id, s]));

    // Accepted stored closes for every held security, merged chronologically
    // with the legacy transaction series (positionCloseAsOf). Every day is
    // valued at the latest accepted close on or before it, so a manual/imported
    // price is honoured exactly as a provider quote is.
    const { stored: pricesBySec, txFallback: txPricesBySec } =
      await this.loadValuationSeries(securityIds, start, end);

    // Load daily cash balances for INVESTMENT_CASH and standalone accounts
    const cashBalances = new Map<string, Map<string, number>>();
    if (cashIds.length > 0) {
      const cashRows: any[] = await this.scopedQuery(
        `WITH target_accounts AS (
            SELECT id, opening_balance
            FROM accounts WHERE id = ANY($1::UUID[])
          ),
          pre_period AS (
            SELECT t.account_id, SUM(t.amount) as total
            FROM transactions t
            JOIN target_accounts ta ON ta.id = t.account_id
            WHERE (t.status IS NULL OR t.status != 'VOID')
              AND t.parent_transaction_id IS NULL
              AND t.transaction_date < $2
            GROUP BY t.account_id
          ),
          daily_tx AS (
            SELECT t.account_id, t.transaction_date::DATE as tx_date, SUM(t.amount) as total
            FROM transactions t
            JOIN target_accounts ta ON ta.id = t.account_id
            WHERE (t.status IS NULL OR t.status != 'VOID')
              AND t.parent_transaction_id IS NULL
              AND t.transaction_date >= $2
              AND t.transaction_date <= $3
            GROUP BY t.account_id, t.transaction_date::DATE
          ),
          account_daily AS (
            SELECT d.dt::DATE as date, ta.id as account_id,
              (ta.opening_balance + COALESCE(pp.total, 0) +
                COALESCE(SUM(dtx.total) OVER (
                  PARTITION BY ta.id ORDER BY d.dt ROWS UNBOUNDED PRECEDING
                ), 0)
              ) as balance
            FROM target_accounts ta
            CROSS JOIN generate_series($2::TIMESTAMP, $3::TIMESTAMP, '1 day') d(dt)
            LEFT JOIN pre_period pp ON pp.account_id = ta.id
            LEFT JOIN daily_tx dtx ON dtx.account_id = ta.id AND dtx.tx_date = d.dt::DATE
          )
          SELECT date::TEXT, balance::NUMERIC, account_id FROM account_daily ORDER BY date`,
        [cashIds, start, end],
      );
      for (const r of cashRows) {
        if (!cashBalances.has(r.account_id))
          cashBalances.set(r.account_id, new Map());
        cashBalances.get(r.account_id)!.set(r.date, Number(r.balance));
      }
    }

    // Generate daily dates
    const dates: string[] = [];
    const d = new Date(start + "T00:00:00");
    const endD = new Date(end + "T00:00:00");
    while (d <= endD) {
      dates.push(d.toISOString().substring(0, 10));
      d.setDate(d.getDate() + 1);
    }

    // Currency conversion setup: include both account currencies (for cash
    // balances) and security currencies (for holdings market value). Prices in
    // security_prices.close_price are stored in the security's native currency,
    // so market value must be converted from security currency -> default
    // currency, not account currency -> default currency.
    const currencies = new Set<string>();
    for (const a of investAccounts) {
      if (a.currency_code !== defaultCurrency) {
        currencies.add(a.currency_code);
      }
    }
    for (const sec of securities) {
      if (sec.currencyCode && sec.currencyCode !== defaultCurrency) {
        currencies.add(sec.currencyCode);
      }
    }
    const rateIndex = await this.buildRateIndex(
      currencies,
      defaultCurrency,
      start,
      end,
    );

    // Build account currency map (used for cash balance conversion)
    const acctCurrency = new Map<string, string>();
    for (const a of investAccounts) {
      acctCurrency.set(a.id, a.currency_code);
    }

    // Replay holdings per-account day by day and compute market value
    // Key: account_id -> (security_id -> quantity)
    const holdingsByAccount = new Map<string, Map<string, number>>();
    let txIdx = 0;

    const result: {
      date: string;
      value: number;
      /** False when a component could not be converted; see missingRatePairs. */
      fxComplete: boolean;
      /** "USD->EUR" for each pair with no available rate. */
      missingRatePairs: string[];
    }[] = [];

    for (const dateStr of dates) {
      // Process investment transactions up to this date
      while (txIdx < invTxs.length) {
        const tx = invTxs[txIdx];
        const txDate = this.toDateString(tx.transaction_date);
        if (txDate > dateStr) break;

        const secId = tx.security_id;
        const acctId = tx.account_id;
        const qty = Number(tx.quantity) || 0;

        if (secId) {
          if (!holdingsByAccount.has(acctId))
            holdingsByAccount.set(acctId, new Map());
          const acctHoldings = holdingsByAccount.get(acctId)!;

          acctHoldings.set(
            secId,
            applyActionToQuantity(acctHoldings.get(secId) || 0, tx.action, qty),
          );
        }
        txIdx++;
      }

      // Compute market value per holding and convert from security currency
      // to default currency. Security prices are stored in the security's
      // native currency, so we must convert each holding individually rather
      // than treating the total as being in the account's currency.
      const dayValue = new FxAggregate();

      for (const [, acctHoldings] of holdingsByAccount) {
        for (const [secId, qty] of acctHoldings) {
          if (Math.abs(qty) < 0.00000001) continue;

          const security = securityMap.get(secId);

          // Value each point at the latest accepted close on or before that day
          // (end-of-day convention). The chart point at date X therefore
          // represents the portfolio's value as of the close of day X, so the
          // series lines up with the month-end-valued monthly snapshots and the
          // final point reflects the most recent available close rather than
          // lagging a trading day behind it. The accepted store wins over the
          // legacy transaction fallback regardless of skipPriceUpdates (#1242).
          const price = positionCloseAsOf(
            pricesBySec.get(secId),
            txPricesBySec.get(secId),
            dateStr,
          );

          if (price != null) {
            const valueInSecCurrency = qty * price;
            const secCurrency = security?.currencyCode || defaultCurrency;
            dayValue.add(
              this.convertCurrency(
                valueInSecCurrency,
                secCurrency,
                defaultCurrency,
                dateStr,
                rateIndex,
              ),
              secCurrency,
              defaultCurrency,
            );
          }
        }
      }

      // Add cash balances for INVESTMENT_CASH and standalone accounts
      for (const [acctId, dailyMap] of cashBalances) {
        const bal = dailyMap.get(dateStr) ?? 0;
        const currency = acctCurrency.get(acctId) || defaultCurrency;
        dayValue.add(
          this.convertCurrency(
            bal,
            currency,
            defaultCurrency,
            dateStr,
            rateIndex,
          ),
          currency,
          defaultCurrency,
        );
      }

      result.push({
        date: dateStr,
        value: Math.round(dayValue.knownSubtotal),
        fxComplete: dayValue.isComplete,
        missingRatePairs: dayValue.missingPairs,
      });
    }

    return result;
  }

  /**
   * Per-security contribution to the portfolio value over time, for the
   * Portfolio Value Over Time report's "by security" view. Replays holdings
   * over the requested window (day-by-day for daily granularity, month-by-month
   * for monthly) and values each security individually, so the returned bands
   * stack up to the total portfolio value. Cash held in investment cash /
   * standalone accounts is returned as its own aggregate band.
   *
   * The `limit` largest securities (ranked by their peak contribution across
   * the window) keep their own band; the rest roll into a single "other" band
   * so a large portfolio stays legible. Read-only; does not touch the stored
   * monthly snapshots that the aggregate views use.
   */
  async getInvestmentBreakdown(
    userId: string,
    opts: {
      granularity: InvestmentBreakdownGranularity;
      startDate?: string;
      endDate?: string;
      accountIds?: string[];
      displayCurrency?: string;
      limit?: number;
    },
  ): Promise<InvestmentBreakdown> {
    const { granularity } = opts;
    const limit = opts.limit ?? 10;

    const pref = await withScopedDb(this.dataSource, (m) =>
      m.getRepository(UserPreference).findOne({ where: { userId } }),
    );
    const defaultCurrency =
      opts.displayCurrency || pref?.defaultCurrency || "USD";

    const end = opts.endDate || new Date().toISOString().slice(0, 10);

    const empty: InvestmentBreakdown = {
      granularity,
      currency: defaultCurrency,
      series: [],
      points: [],
      // Nothing to convert is complete, not unknown.
      fxComplete: true,
      missingRatePairs: [],
    };

    const investAccounts = await this.resolveScopedInvestmentAccounts(
      userId,
      opts.accountIds,
    );
    if (investAccounts.length === 0) return empty;

    // "All time" (no startDate) begins where the scope's own history begins.
    const start =
      opts.startDate ||
      (await this.resolveInvestmentInception(
        investAccounts.map((a) => a.id),
        end,
      ));

    const brokerageIds = investAccounts
      .filter(
        (a) =>
          a.account_sub_type === "INVESTMENT_BROKERAGE" ||
          (a.account_type === "INVESTMENT" && !a.account_sub_type),
      )
      .map((a) => a.id);
    const cashIds = investAccounts
      .filter(
        (a) =>
          a.account_sub_type === "INVESTMENT_CASH" ||
          (a.account_type === "INVESTMENT" && !a.account_sub_type),
      )
      .map((a) => a.id);

    // Investment transactions from inception up to the window end, so holdings
    // can be replayed forward to each sample point.
    const invTxs: any[] =
      brokerageIds.length > 0
        ? await this.scopedQuery(
            `SELECT account_id, security_id, action, quantity, transaction_date
             FROM investment_transactions
             WHERE account_id = ANY($1::UUID[])
               AND transaction_date <= $2
               AND status != 'VOID'
             ORDER BY transaction_date ASC, created_at ASC`,
            [brokerageIds, end],
          )
        : [];

    const securityIds = [
      ...new Set(
        invTxs.filter((t: any) => t.security_id).map((t: any) => t.security_id),
      ),
    ];
    const securities =
      securityIds.length > 0
        ? await withScopedDb(this.dataSource, (m) =>
            m.getRepository(Security).findByIds(securityIds),
          )
        : [];
    const securityMap = new Map(securities.map((s) => [s.id, s]));

    // Build the ordered list of sample dates and, for each, a valuation date
    // (the date whose close values that point) plus a price lookup.
    const sampleDates =
      granularity === "monthly"
        ? this.enumerateMonths(start, end)
        : this.enumerateDays(start, end);
    if (sampleDates.length === 0) return empty;

    // --- Price lookups -------------------------------------------------------
    // Every point is valued at the latest accepted close on or before its
    // valuation date (the day itself for daily, the month end for monthly),
    // from security_prices merged chronologically with the legacy transaction
    // series. One load for both granularities and no skipPriceUpdates branch --
    // see positionCloseAsOf (#1242).
    // Window the price load to the samples actually valued: monthly points are
    // valued at their month end, which can run past the report `end`, so bound
    // to the last sample's valuation date rather than to `end`.
    const lastSample = sampleDates[sampleDates.length - 1];
    const loadEnd =
      granularity === "monthly" ? this.monthEndDate(lastSample) : lastSample;
    const { stored: storedSeries, txFallback: txSeries } =
      await this.loadValuationSeries(securityIds, sampleDates[0], loadEnd);

    // --- Cash balances -------------------------------------------------------
    const cashBalances = new Map<string, Map<string, number>>();
    if (cashIds.length > 0) {
      const cashRows: any[] =
        granularity === "monthly"
          ? await this.loadMonthlyCashBalances(cashIds, start, end)
          : await this.loadDailyCashBalances(cashIds, start, end);
      for (const r of cashRows) {
        if (!cashBalances.has(r.account_id))
          cashBalances.set(r.account_id, new Map());
        cashBalances
          .get(r.account_id)!
          .set(this.toDateString(r.date ?? r.month), Number(r.balance));
      }
    }

    // --- Currency conversion -------------------------------------------------
    const currencies = new Set<string>();
    for (const a of investAccounts) {
      if (a.currency_code !== defaultCurrency) currencies.add(a.currency_code);
    }
    for (const sec of securities) {
      if (sec.currencyCode && sec.currencyCode !== defaultCurrency) {
        currencies.add(sec.currencyCode);
      }
    }
    const rateIndex = await this.buildRateIndex(
      currencies,
      defaultCurrency,
      start,
      end,
    );

    const acctCurrency = new Map<string, string>();
    for (const a of investAccounts) acctCurrency.set(a.id, a.currency_code);

    // --- Replay holdings, accumulating per security --------------------------
    const holdings = new Map<string, number>(); // securityId -> quantity
    let txIdx = 0;

    const ungrouped: Array<{
      date: string;
      valuesBySec: Map<string, number>;
      cash: number;
    }> = [];

    // Pairs the whole breakdown could not resolve a rate for. Collected across
    // every sample so the response can name them rather than presenting a
    // subtotal as a total (P5-009).
    const missingPairs = new Set<string>();

    for (const sampleDate of sampleDates) {
      const valuationDate =
        granularity === "monthly" ? this.monthEndDate(sampleDate) : sampleDate;

      // Apply every transaction up to this sample point. Daily includes
      // transactions dated on the day itself; monthly includes any transaction
      // whose month is at or before the sample month.
      while (txIdx < invTxs.length) {
        const tx = invTxs[txIdx];
        const txDate = this.toDateString(tx.transaction_date);
        if (granularity === "monthly") {
          if (txDate.substring(0, 7) > sampleDate.substring(0, 7)) break;
        } else if (txDate > sampleDate) {
          break;
        }

        const secId = tx.security_id;
        const qty = Number(tx.quantity) || 0;
        if (secId) {
          holdings.set(
            secId,
            applyActionToQuantity(holdings.get(secId) || 0, tx.action, qty),
          );
        }
        txIdx++;
      }

      const valuesBySec = new Map<string, number>();
      for (const [secId, qty] of holdings) {
        if (Math.abs(qty) < 0.00000001) continue;
        const security = securityMap.get(secId);
        const price = positionCloseAsOf(
          storedSeries.get(secId),
          txSeries.get(secId),
          valuationDate,
        );
        if (price == null) continue;
        const secCurrency = security?.currencyCode || defaultCurrency;
        const value = this.convertCurrency(
          qty * price,
          secCurrency,
          defaultCurrency,
          valuationDate,
          rateIndex,
        );
        // A position with no rate for its pair is left out of the breakdown
        // rather than entered at 1:1, and recorded so the point can say so.
        if (value === null) {
          missingPairs.add(`${secCurrency}->${defaultCurrency}`);
          continue;
        }
        valuesBySec.set(secId, (valuesBySec.get(secId) ?? 0) + value);
      }

      // Cash maps are keyed by the sample date itself: day strings for daily,
      // month-first strings for monthly.
      const cashAggregate = new FxAggregate();
      for (const [acctId, dailyMap] of cashBalances) {
        const bal = dailyMap.get(sampleDate) ?? 0;
        if (bal === 0) continue;
        const currency = acctCurrency.get(acctId) || defaultCurrency;
        cashAggregate.add(
          this.convertCurrency(
            bal,
            currency,
            defaultCurrency,
            valuationDate,
            rateIndex,
          ),
          currency,
          defaultCurrency,
        );
      }
      for (const pair of cashAggregate.missingPairs) missingPairs.add(pair);

      ungrouped.push({
        date: sampleDate,
        valuesBySec,
        cash: cashAggregate.knownSubtotal,
      });
    }

    const { series, points } = this.groupSecurityBreakdown(
      ungrouped,
      securityMap,
      limit,
    );
    return {
      granularity,
      currency: defaultCurrency,
      series,
      points,
      fxComplete: missingPairs.size === 0,
      missingRatePairs: [...missingPairs].sort(),
    };
  }

  // ---- Private helpers ----

  /**
   * Resolve the investment accounts in scope for a breakdown request, mirroring
   * getDailyInvestments: an explicit id list resolves its linked pairs, an
   * empty list falls back to all of the user's investment cash / brokerage /
   * standalone accounts. Returns the lightweight account rows the replay needs.
   */
  private async resolveScopedInvestmentAccounts(
    userId: string,
    accountIds?: string[],
  ): Promise<
    Array<{
      id: string;
      account_type: string;
      account_sub_type: string | null;
      currency_code: string;
      opening_balance: string | number;
    }>
  > {
    let accountFilter = "";
    const acctParams: any[] = [userId];

    if (accountIds && accountIds.length > 0) {
      const resolved: { id: string }[] = await this.scopedQuery(
        `SELECT id FROM accounts
         WHERE user_id = $2
           AND (
             id = ANY($1)
             OR linked_account_id = ANY($1)
             OR id IN (
               SELECT linked_account_id FROM accounts
               WHERE id = ANY($1) AND user_id = $2
             )
           )`,
        [accountIds, userId],
      );
      const idArray = [...new Set(resolved.map((a) => a.id))];
      if (idArray.length === 0) return [];
      const placeholders = idArray.map((_, i) => `$${i + 2}`).join(", ");
      accountFilter = `AND a.id IN (${placeholders})`;
      acctParams.push(...idArray);
    } else {
      accountFilter = `AND (a.account_sub_type IN ('INVESTMENT_CASH', 'INVESTMENT_BROKERAGE') OR (a.account_type = 'INVESTMENT' AND a.account_sub_type IS NULL))`;
    }

    return this.scopedQuery(
      `SELECT a.id, a.account_type, a.account_sub_type, a.currency_code, a.opening_balance
       FROM accounts a
       WHERE a.user_id = $1 ${accountFilter}`,
      acctParams,
    );
  }

  /**
   * Window start for a request that asked for "all time" (no startDate): the
   * earliest date the scoped accounts have anything to show. Per account that
   * is its first non-void transaction or investment transaction, falling back
   * to the date the account was created when it has neither -- the same rule
   * `resolveStartDate` / `recalculateBrokerageAccount` use to decide where an
   * account's monthly snapshots begin, so the by-security chart and the total
   * chart start on the same point rather than years apart.
   *
   * A fixed epoch here is what issue #1081 reported: the per-security series
   * enumerates every sample between start and end, so "all time" prepended
   * three decades of empty months and flattened the real data against the
   * x-axis. Callers resolve their account scope first and return early when it
   * is empty, so this never has to invent a date for an empty scope; the result
   * is clamped to `end` so a reversed window still yields a single point.
   */
  private async resolveInvestmentInception(
    accountIds: string[],
    end: string,
  ): Promise<string> {
    const rows: Array<{ earliest: string | Date | null }> =
      await this.scopedQuery(
        `WITH scoped AS (
            SELECT a.id, a.created_at FROM accounts a WHERE a.id = ANY($1::UUID[])
          ),
          first_tx AS (
            SELECT t.account_id, MIN(t.transaction_date) AS d
              FROM transactions t
             WHERE t.account_id = ANY($1::UUID[])
               AND (t.status IS NULL OR t.status != 'VOID')
               AND t.parent_transaction_id IS NULL
             GROUP BY t.account_id
          ),
          first_inv AS (
            SELECT it.account_id, MIN(it.transaction_date) AS d
              FROM investment_transactions it
             WHERE it.account_id = ANY($1::UUID[])
               AND it.status != 'VOID'
             GROUP BY it.account_id
          )
          SELECT MIN(
                   COALESCE(LEAST(ft.d, fi.d), s.created_at::DATE)
                 )::TEXT AS earliest
            FROM scoped s
            LEFT JOIN first_tx ft ON ft.account_id = s.id
            LEFT JOIN first_inv fi ON fi.account_id = s.id`,
        [accountIds],
      );

    const earliest = rows?.[0]?.earliest;
    if (!earliest) return end;
    const inception = this.toDateString(earliest);
    return inception > end ? end : inception;
  }

  /** All calendar days in [start, end] inclusive, as YYYY-MM-DD strings. */
  private enumerateDays(start: string, end: string): string[] {
    const dates: string[] = [];
    const d = new Date(start + "T00:00:00");
    const endD = new Date(end + "T00:00:00");
    while (d <= endD) {
      dates.push(d.toISOString().substring(0, 10));
      d.setDate(d.getDate() + 1);
    }
    return dates;
  }

  /** Month-first dates for every month spanned by [start, end], YYYY-MM-01. */
  private enumerateMonths(start: string, end: string): string[] {
    const months: string[] = [];
    const [sy, sm] = start.split("-").map(Number);
    const [ey, em] = end.split("-").map(Number);
    let y = sy;
    let m = sm;
    while (y < ey || (y === ey && m <= em)) {
      months.push(`${y}-${String(m).padStart(2, "0")}-01`);
      m += 1;
      if (m > 12) {
        m = 1;
        y += 1;
      }
    }
    return months;
  }

  /** Per-day cash balances for investment cash / standalone accounts. */
  private async loadDailyCashBalances(
    cashIds: string[],
    start: string,
    end: string,
  ): Promise<any[]> {
    return this.scopedQuery(
      `WITH target_accounts AS (
          SELECT id, opening_balance
          FROM accounts WHERE id = ANY($1::UUID[])
        ),
        pre_period AS (
          SELECT t.account_id, SUM(t.amount) as total
          FROM transactions t
          JOIN target_accounts ta ON ta.id = t.account_id
          WHERE (t.status IS NULL OR t.status != 'VOID')
            AND t.parent_transaction_id IS NULL
            AND t.transaction_date < $2
          GROUP BY t.account_id
        ),
        daily_tx AS (
          SELECT t.account_id, t.transaction_date::DATE as tx_date, SUM(t.amount) as total
          FROM transactions t
          JOIN target_accounts ta ON ta.id = t.account_id
          WHERE (t.status IS NULL OR t.status != 'VOID')
            AND t.parent_transaction_id IS NULL
            AND t.transaction_date >= $2
            AND t.transaction_date <= $3
          GROUP BY t.account_id, t.transaction_date::DATE
        ),
        account_daily AS (
          SELECT d.dt::DATE as date, ta.id as account_id,
            (ta.opening_balance + COALESCE(pp.total, 0) +
              COALESCE(SUM(dtx.total) OVER (
                PARTITION BY ta.id ORDER BY d.dt ROWS UNBOUNDED PRECEDING
              ), 0)
            ) as balance
          FROM target_accounts ta
          CROSS JOIN generate_series($2::TIMESTAMP, $3::TIMESTAMP, '1 day') d(dt)
          LEFT JOIN pre_period pp ON pp.account_id = ta.id
          LEFT JOIN daily_tx dtx ON dtx.account_id = ta.id AND dtx.tx_date = d.dt::DATE
        )
        SELECT date::TEXT, balance::NUMERIC, account_id FROM account_daily ORDER BY date`,
      [cashIds, start, end],
    );
  }

  /** Per-month-end cash balances for investment cash / standalone accounts. */
  private async loadMonthlyCashBalances(
    cashIds: string[],
    start: string,
    end: string,
  ): Promise<any[]> {
    return this.scopedQuery(
      `WITH target_accounts AS (
          SELECT id, opening_balance FROM accounts WHERE id = ANY($1::UUID[])
        ),
        bounds AS (
          SELECT date_trunc('month', $2::DATE)::DATE AS start_m,
                 date_trunc('month', $3::DATE)::DATE AS end_m
        ),
        pre_period AS (
          SELECT t.account_id, SUM(t.amount) as total
          FROM transactions t
          JOIN target_accounts ta ON ta.id = t.account_id
          CROSS JOIN bounds b
          WHERE (t.status IS NULL OR t.status != 'VOID')
            AND t.parent_transaction_id IS NULL
            AND t.transaction_date < b.start_m
          GROUP BY t.account_id
        ),
        monthly_tx AS (
          SELECT t.account_id, date_trunc('month', t.transaction_date)::DATE as month,
                 SUM(t.amount) as total
          FROM transactions t
          JOIN target_accounts ta ON ta.id = t.account_id
          CROSS JOIN bounds b
          WHERE (t.status IS NULL OR t.status != 'VOID')
            AND t.parent_transaction_id IS NULL
            AND t.transaction_date >= b.start_m
            AND t.transaction_date <= $3
          GROUP BY t.account_id, date_trunc('month', t.transaction_date)
        ),
        month_series AS (
          SELECT gs::DATE AS m FROM bounds b,
            generate_series(b.start_m, b.end_m, '1 month') gs
        )
        SELECT ta.id as account_id, s.m::TEXT as month,
          (ta.opening_balance + COALESCE(pp.total, 0) +
            COALESCE(SUM(mt.total) OVER (
              PARTITION BY ta.id ORDER BY s.m ROWS UNBOUNDED PRECEDING
            ), 0)
          )::NUMERIC as balance
        FROM target_accounts ta
        CROSS JOIN month_series s
        LEFT JOIN pre_period pp ON pp.account_id = ta.id
        LEFT JOIN monthly_tx mt ON mt.account_id = ta.id AND mt.month = s.m
        ORDER BY s.m`,
      [cashIds, start, end],
    );
  }

  /**
   * Rank securities by peak contribution, keep the top `limit` as their own
   * bands, roll the remainder into a single "other" band, and append a cash
   * band when any cash is present. Each band value is rounded to whole units so
   * the stacked bands add up exactly to the point total shown to the user.
   */
  private groupSecurityBreakdown(
    ungrouped: Array<{
      date: string;
      valuesBySec: Map<string, number>;
      cash: number;
    }>,
    securityMap: Map<string, Security>,
    limit: number,
  ): {
    series: InvestmentBreakdownSeries[];
    points: InvestmentBreakdownPoint[];
  } {
    const peak = new Map<string, number>();
    for (const pt of ungrouped) {
      for (const [secId, val] of pt.valuesBySec) {
        if (Math.abs(val) > Math.abs(peak.get(secId) ?? 0)) {
          peak.set(secId, val);
        }
      }
    }

    const rankedSecIds = [...peak.entries()]
      .filter(([, v]) => Math.abs(v) >= 0.005)
      .sort((a, b) => {
        const diff = Math.abs(b[1]) - Math.abs(a[1]);
        if (diff !== 0) return diff;
        const an = securityMap.get(a[0])?.name ?? "";
        const bn = securityMap.get(b[0])?.name ?? "";
        return an.localeCompare(bn);
      })
      .map(([secId]) => secId);

    const topIds = rankedSecIds.slice(0, limit);
    const otherIds = new Set(rankedSecIds.slice(limit));
    const hasOther = otherIds.size > 0;
    const hasCash = ungrouped.some((pt) => Math.abs(pt.cash) >= 0.005);

    const series: InvestmentBreakdownSeries[] = topIds.map((secId) => {
      const sec = securityMap.get(secId);
      return {
        key: secId,
        type: "security",
        symbol: sec?.symbol ?? null,
        name: sec?.name ?? sec?.symbol ?? secId,
      };
    });
    if (hasOther)
      series.push({ key: "other", type: "other", symbol: null, name: "" });
    if (hasCash)
      series.push({ key: "cash", type: "cash", symbol: null, name: "" });

    const points: InvestmentBreakdownPoint[] = ungrouped.map((pt) => {
      const values: Record<string, number> = {};
      let total = 0;
      for (const secId of topIds) {
        const v = Math.round(pt.valuesBySec.get(secId) ?? 0);
        values[secId] = v;
        total += v;
      }
      if (hasOther) {
        let otherSum = 0;
        for (const secId of otherIds)
          otherSum += pt.valuesBySec.get(secId) ?? 0;
        const v = Math.round(otherSum);
        values.other = v;
        total += v;
      }
      if (hasCash) {
        const v = Math.round(pt.cash);
        values.cash = v;
        total += v;
      }
      return { date: pt.date, total, values };
    });

    return { series, points };
  }

  private async recalculateRegularAccount(
    userId: string,
    account: Account,
  ): Promise<void> {
    const openingBalance = Number(account.openingBalance) || 0;

    const [{ earliest }] = await this.scopedQuery(
      `SELECT MIN(transaction_date) as earliest
       FROM transactions
       WHERE account_id = $1
         AND (status IS NULL OR status != 'VOID')
         AND parent_transaction_id IS NULL`,
      [account.id],
    );

    let startDate = this.resolveStartDate(account, earliest);

    // For ASSET with dateAcquired, ensure we start from the earlier of dateAcquired or first tx
    if (account.accountType === AccountType.ASSET && account.dateAcquired) {
      const daStr = this.toDateString(account.dateAcquired);
      if (daStr < startDate) startDate = daStr;
    }

    const rows: any[] = await this.scopedQuery(
      `WITH monthly_tx_sums AS (
        SELECT DATE_TRUNC('month', transaction_date)::DATE as month,
               SUM(amount) as total
        FROM transactions
        WHERE account_id = $1
          AND (status IS NULL OR status != 'VOID')
          AND parent_transaction_id IS NULL
          AND transaction_date <= CURRENT_DATE
        GROUP BY 1
      )
      SELECT m.month::DATE as month,
             ($2::NUMERIC + COALESCE(
               SUM(mts.total) OVER (ORDER BY m.month ROWS UNBOUNDED PRECEDING),
               0
             )) as balance
      FROM generate_series(
        DATE_TRUNC('month', $3::DATE)::TIMESTAMP,
        DATE_TRUNC('month', CURRENT_DATE)::TIMESTAMP,
        '1 month'::INTERVAL
      ) m(month)
      LEFT JOIN monthly_tx_sums mts ON mts.month = m.month::DATE
      ORDER BY m.month`,
      [account.id, openingBalance, startDate],
    );

    // Determine dateAcquired month for ASSET zeroing
    let dateAcquiredYM: string | null = null;
    if (account.accountType === AccountType.ASSET && account.dateAcquired) {
      dateAcquiredYM = this.toDateString(account.dateAcquired).substring(0, 7);
    }

    // Atomic delete + insert
    await withScopedDb(this.dataSource, async (m) => {
      await m.query(
        "DELETE FROM monthly_account_balances WHERE account_id = $1",
        [account.id],
      );

      for (const row of rows) {
        const monthStr = this.toDateString(row.month);
        const monthYM = monthStr.substring(0, 7);

        let balance = Number(row.balance);
        if (dateAcquiredYM && monthYM < dateAcquiredYM) {
          balance = 0;
        }

        await m.query(
          `INSERT INTO monthly_account_balances (user_id, account_id, month, balance)
           VALUES ($1, $2, $3::DATE, $4)`,
          [userId, account.id, monthStr, balance],
        );
      }
    });
  }

  private async recalculateBrokerageAccount(
    userId: string,
    account: Account,
  ): Promise<void> {
    const openingBalance = Number(account.openingBalance) || 0;

    // Find earliest date from both regular and investment transactions
    const [{ earliest }] = await this.scopedQuery(
      `SELECT MIN(transaction_date) as earliest
       FROM transactions
       WHERE account_id = $1
         AND (status IS NULL OR status != 'VOID')
         AND parent_transaction_id IS NULL`,
      [account.id],
    );

    const [{ inv_earliest }] = await this.scopedQuery(
      `SELECT MIN(transaction_date) as inv_earliest
       FROM investment_transactions
       WHERE account_id = $1
         AND status != 'VOID'`,
      [account.id],
    );

    const dates: string[] = [];
    if (earliest) dates.push(this.toDateString(earliest));
    if (inv_earliest) dates.push(this.toDateString(inv_earliest));
    const startDate =
      dates.length > 0
        ? dates.sort()[0]
        : account.createdAt.toISOString().substring(0, 10);

    // Compute cost-basis via cumulative transaction sums
    const costRows: any[] = await this.scopedQuery(
      `WITH monthly_tx_sums AS (
        SELECT DATE_TRUNC('month', transaction_date)::DATE as month,
               SUM(amount) as total
        FROM transactions
        WHERE account_id = $1
          AND (status IS NULL OR status != 'VOID')
          AND parent_transaction_id IS NULL
          AND transaction_date <= CURRENT_DATE
        GROUP BY 1
      )
      SELECT m.month::DATE as month,
             ($2::NUMERIC + COALESCE(
               SUM(mts.total) OVER (ORDER BY m.month ROWS UNBOUNDED PRECEDING),
               0
             )) as balance
      FROM generate_series(
        DATE_TRUNC('month', $3::DATE)::TIMESTAMP,
        DATE_TRUNC('month', CURRENT_DATE)::TIMESTAMP,
        '1 month'::INTERVAL
      ) m(month)
      LEFT JOIN monthly_tx_sums mts ON mts.month = m.month::DATE
      ORDER BY m.month`,
      [account.id, openingBalance, startDate],
    );

    const costByMonth = new Map<string, number>();
    const months: string[] = [];
    for (const row of costRows) {
      const monthStr = this.toDateString(row.month);
      costByMonth.set(monthStr, Number(row.balance));
      months.push(monthStr);
    }

    // Load investment transactions for holdings replay (exclude future-dated)
    const today = formatDateYMDLocal(new Date());
    const invTxs = await withScopedDb(this.dataSource, (m) =>
      m.getRepository(InvestmentTransaction).find({
        where: {
          accountId: account.id,
          transactionDate: LessThanOrEqual(today),
          // Rows as effects: a VOID transaction moved no shares.
          status: NON_VOID_INVESTMENT_STATUS,
        },
        order: { transactionDate: "ASC", createdAt: "ASC" },
      }),
    );

    const securityIds = [
      ...new Set(invTxs.filter((t) => t.securityId).map((t) => t.securityId!)),
    ];
    const securities =
      securityIds.length > 0
        ? await withScopedDb(this.dataSource, (m) =>
            m.getRepository(Security).findByIds(securityIds),
          )
        : [];
    const securityMap = new Map(securities.map((s) => [s.id, s]));

    // Preload accepted stored prices for every held security (plus the legacy
    // transaction fallback). Not keyed on skipPriceUpdates -- see
    // loadValuationSeries / positionCloseAsOf (#1242). The window spans the
    // months being (re)built, from the first month through its month end, so
    // every month-end valuation below is covered without loading lifetime
    // history.
    const windowStart = months[0] ?? startDate;
    const windowEnd =
      months.length > 0
        ? this.monthEndDate(months[months.length - 1])
        : today;
    const { stored: storedPrices, txFallback: txPrices } =
      await this.loadValuationSeries(securityIds, windowStart, windowEnd);

    // Build a rate index for security currencies -> account currency so that
    // per-holding market values (which are stored in the security's native
    // currency) can be converted to the account's currency before being
    // written to monthly_account_balances.market_value. The read path in
    // getMonthlyInvestments converts the stored value from account currency
    // to the user's display currency, so the stored value must be in the
    // account currency.
    const secCurrencies = new Set<string>();
    for (const sec of securities) {
      if (sec.currencyCode && sec.currencyCode !== account.currencyCode) {
        secCurrencies.add(sec.currencyCode);
      }
    }
    const mvRateIndex =
      secCurrencies.size > 0 && months.length > 0
        ? await this.buildRateIndex(
            secCurrencies,
            account.currencyCode,
            months[0],
            months[months.length - 1],
          )
        : new Map();

    // Replay holdings month by month
    const holdings = new Map<string, number>();
    let txIdx = 0;
    const marketValueByMonth = new Map<string, number>();

    for (const monthStr of months) {
      const monthYM = monthStr.substring(0, 7);

      // Process investment transactions up to this month
      while (txIdx < invTxs.length) {
        const tx = invTxs[txIdx];
        const txYM = tx.transactionDate.substring(0, 7);
        if (txYM > monthYM) break;

        const secId = tx.securityId;
        const qty = Number(tx.quantity) || 0;

        if (secId) {
          holdings.set(
            secId,
            applyActionToQuantity(holdings.get(secId) || 0, tx.action, qty),
          );
        }
        txIdx++;
      }

      // Compute market value from holdings. Each holding's value is in the
      // security's native currency; convert to the account's currency at the
      // month-end exchange rate before summing.
      const monthValue = new FxAggregate();
      const monthEndStr = this.monthEndDate(monthStr);
      for (const [secId, qty] of holdings) {
        if (Math.abs(qty) < 0.00000001) continue;

        const security = securityMap.get(secId);
        // Latest accepted close on or before month end, from security_prices
        // merged chronologically with the legacy transaction series. #1242.
        const price = positionCloseAsOf(
          storedPrices.get(secId),
          txPrices.get(secId),
          monthEndStr,
        );

        if (price != null) {
          const valueInSecCurrency = qty * price;
          const secCurrency = security?.currencyCode || account.currencyCode;
          monthValue.add(
            this.convertCurrency(
              valueInSecCurrency,
              secCurrency,
              account.currencyCode,
              monthEndStr,
              mvRateIndex,
            ),
            secCurrency,
            account.currencyCode,
          );
        }
      }

      // This value is persisted to monthly_account_balances, which has no
      // column to record that a conversion was incomplete. Per
      // docs/specs/fx-conversion-completeness.md section 5, the snapshot is
      // written from the subtotal and the gap is logged rather than silently
      // absorbed at 1:1; adding a completeness column is a separate migration.
      if (!monthValue.isComplete) {
        this.logger.warn(
          `Snapshot for account ${account.id} month ${monthStr} omits positions with no exchange rate (${monthValue.missingPairs.join(", ")}); the stored market value is a subtotal`,
        );
      }

      marketValueByMonth.set(monthStr, monthValue.knownSubtotal);
    }

    // Atomic write
    await withScopedDb(this.dataSource, async (m) => {
      await m.query(
        "DELETE FROM monthly_account_balances WHERE account_id = $1",
        [account.id],
      );

      for (const monthStr of months) {
        const balance = costByMonth.get(monthStr) ?? 0;
        const mv = marketValueByMonth.get(monthStr) ?? null;

        await m.query(
          `INSERT INTO monthly_account_balances
             (user_id, account_id, month, balance, market_value)
           VALUES ($1, $2, $3::DATE, $4, $5)`,
          [userId, account.id, monthStr, balance, mv],
        );
      }
    });
  }

  /**
   * Accepted stored closes per security (`security_prices.close_price`), sorted
   * oldest-first, for **every** requested security regardless of
   * `skipPriceUpdates`. This is the authoritative valuation source: provider
   * quotes, imports, manual corrections and transaction-derived observations
   * all live here with source precedence already applied at write time. Keying
   * the load on `skipPriceUpdates` -- and then valuing skip-flagged securities
   * from raw transaction prices instead -- is what left a manually corrected
   * 401(k) reporting its old transaction price on every historical chart
   * (issue #1242). That flag is a fetch-eligibility rule, not a valuation one.
   *
   * Bounded to the report window (`[start, end]`) plus the single most recent
   * observation *before* `start`, which is the carry-forward that values the
   * window's first day. Loading the whole lifetime history of every held
   * security to answer a one-week chart is millions of avoidable rows on a
   * large portfolio (review MZ-1242-R4). The pre-window boundary keeps an
   * arbitrarily old sparse/manual price usable without loading everything
   * between it and the window.
   */
  private async loadStoredPriceSeries(
    securityIds: string[],
    start: string,
    end: string,
  ): Promise<Map<string, PricePoint[]>> {
    const result = new Map<string, PricePoint[]>();
    if (securityIds.length === 0) return result;

    const rows: any[] = await this.scopedQuery(
      `WITH boundary AS (
         SELECT DISTINCT ON (security_id) security_id, price_date, close_price
           FROM security_prices
          WHERE security_id = ANY($1::UUID[])
            AND price_date < $2::DATE
          ORDER BY security_id, price_date DESC
       ),
       windowed AS (
         SELECT security_id, price_date, close_price
           FROM security_prices
          WHERE security_id = ANY($1::UUID[])
            AND price_date >= $2::DATE
            AND price_date <= $3::DATE
       )
       SELECT security_id, price_date, close_price FROM boundary
       UNION ALL
       SELECT security_id, price_date, close_price FROM windowed
       ORDER BY security_id, price_date`,
      [securityIds, start, end],
    );
    for (const r of rows) {
      const arr = result.get(r.security_id) ?? [];
      arr.push({
        date: this.toDateString(r.price_date),
        close: Number(r.close_price),
      });
      result.set(r.security_id, arr);
    }
    return result;
  }

  /**
   * Transaction-derived closes per security, read directly from
   * `investment_transactions` -- the legacy fallback (see `positionCloseAsOf`).
   * Every accepted transaction observation is normally mirrored into
   * `security_prices`, so this only carries anything for legacy data absent
   * from the store; it is loaded for every security and merged chronologically
   * so a stored series that begins mid-window does not suppress the legacy
   * history that values its earlier dates (review MZ-1242-R1).
   *
   * Same-day trades are averaged and rounded to six decimals
   * (`ROUND(AVG(price), 6)`), reproducing exactly what
   * `SecurityPriceService.upsertTransactionPrice` would have written to
   * `security_prices` (which rounds to 1e-6) -- not the raw driver average,
   * which differs in the last places (review MZ-1242-R8) -- rather than letting
   * the last row of the day stand in for the session. The row filter is
   * `price IS NOT NULL`, matching the canonical writer exactly: a zero-price
   * disposal (a `SELL`/`REDEEM` at $0, which the service allows) is a real
   * observation the writer stores, so excluding it with `price > 0` would let
   * the fallback carry an older price forward where the writer would not
   * (review MZ-1242-R10).
   *
   * Bounded to the window plus one pre-window observation, as the stored loader
   * is. The aggregate is applied *after* the date predicates rather than over
   * an all-time CTE referenced twice: a lifetime aggregate that PostgreSQL 16
   * materializes before filtering scans every transaction of every held
   * security for a one-week report (review MZ-1242-R7). The boundary date is
   * resolved first with a bounded lookup, then only rows on that date and rows
   * inside `[start, end]` are aggregated.
   */
  private async loadTxPriceSeries(
    securityIds: string[],
    start: string,
    end: string,
  ): Promise<Map<string, PricePoint[]>> {
    const result = new Map<string, PricePoint[]>();
    if (securityIds.length === 0) return result;

    const rows: any[] = await this.scopedQuery(
      `WITH boundary_dates AS (
         SELECT DISTINCT ON (security_id) security_id, transaction_date
           FROM investment_transactions
          WHERE security_id = ANY($1::UUID[])
            AND action = ANY($2)
            AND price IS NOT NULL
            AND status != 'VOID'
            AND transaction_date < $3::DATE
          ORDER BY security_id, transaction_date DESC
       ),
       boundary AS (
         SELECT it.security_id, it.transaction_date,
                ROUND(AVG(it.price::numeric), 6) AS price
           FROM investment_transactions it
           JOIN boundary_dates bd
             ON bd.security_id = it.security_id
            AND bd.transaction_date = it.transaction_date
          WHERE it.action = ANY($2)
            AND it.price IS NOT NULL
            AND it.status != 'VOID'
          GROUP BY it.security_id, it.transaction_date
       ),
       windowed AS (
         SELECT security_id, transaction_date,
                ROUND(AVG(price::numeric), 6) AS price
           FROM investment_transactions
          WHERE security_id = ANY($1::UUID[])
            AND action = ANY($2)
            AND price IS NOT NULL
            AND status != 'VOID'
            AND transaction_date >= $3::DATE
            AND transaction_date <= $4::DATE
          GROUP BY security_id, transaction_date
       )
       SELECT security_id, transaction_date, price FROM boundary
       UNION ALL
       SELECT security_id, transaction_date, price FROM windowed
       ORDER BY security_id, transaction_date`,
      [securityIds, MARKET_PRICED_TRADE_ACTIONS, start, end],
    );
    for (const r of rows) {
      const arr = result.get(r.security_id) ?? [];
      arr.push({
        date: this.toDateString(r.transaction_date),
        close: Number(r.price),
      });
      result.set(r.security_id, arr);
    }
    return result;
  }

  /**
   * The pair `positionCloseAsOf` reads: the accepted stored series and the
   * legacy transaction-derived series, both for every requested security and
   * both bounded to `[start, end]` plus one pre-window observation.
   * `skipPriceUpdates` plays no part -- the store is authoritative and the two
   * are merged chronologically, so an accepted price always wins on its date
   * while legacy history still values dates the store does not reach.
   */
  private async loadValuationSeries(
    securityIds: string[],
    start: string,
    end: string,
  ): Promise<{
    stored: Map<string, PricePoint[]>;
    txFallback: Map<string, PricePoint[]>;
  }> {
    const [stored, txFallback] = await Promise.all([
      this.loadStoredPriceSeries(securityIds, start, end),
      this.loadTxPriceSeries(securityIds, start, end),
    ]);
    return { stored, txFallback };
  }

  private async buildRateIndex(
    currencies: Set<string>,
    defaultCurrency: string,
    startDate: string,
    endDate: string,
  ): Promise<RateIndex> {
    if (currencies.size === 0) return new Map();

    const currArr = Array.from(currencies);
    const rates: any[] = await this.scopedQuery(
      `SELECT from_currency, to_currency, rate, rate_date
       FROM exchange_rates
       WHERE ((from_currency = ANY($1::TEXT[]) AND to_currency = $2)
           OR (from_currency = $2 AND to_currency = ANY($1::TEXT[])))
         AND rate_date >= ($3::DATE - INTERVAL '90 days')
         AND rate_date <= ($4::DATE + INTERVAL '31 days')
       ORDER BY rate_date`,
      [currArr, defaultCurrency, startDate, endDate],
    );

    const index: RateIndex = new Map();
    for (const r of rates) {
      const key = `${r.from_currency}->${r.to_currency}`;
      if (!index.has(key)) index.set(key, []);
      index.get(key)!.push({
        date: this.toDateString(r.rate_date),
        rate: Number(r.rate),
      });
    }

    return index;
  }

  /**
   * Date-aware conversion into the reporting currency. Returns `null` when no
   * rate exists for the pair.
   *
   * `null`, not the amount unchanged: this used to end in `result ?? amount`,
   * which reported 1,000 USD as 1,000 EUR and left a consumer unable to tell
   * that from a genuine 1:1 pair (audit P5-009). The direct/inverse decision
   * lives in the shared `convertWithRateLookup` so reports and net worth cannot
   * diverge on how a pair resolves. Callers accumulate through `FxAggregate`;
   * see `docs/specs/fx-conversion-completeness.md`.
   */
  private convertCurrency(
    amount: number,
    from: string,
    to: string,
    monthEnd: string,
    rateIndex: RateIndex,
  ): number | null {
    // Zero converts to zero at any rate, so it needs none (and records no
    // gap): an emptied account in a currency with no stored rates is a settled
    // zero, not an unknowable value, and flagging it incomplete would report a
    // question that was never open as one that could not be answered.
    if (amount === 0) return 0;

    const converted = convertWithRateLookup(amount, from, to, (f, t) => {
      const rates = rateIndex.get(`${f}->${t}`);
      return rates
        ? this.findBestRate(rates, `${f}->${t}`, monthEnd)
        : undefined;
    });
    if (converted === null) {
      this.logger.warn(
        `No exchange rate available for ${from}->${to} on or around ${monthEnd}; the affected total is reported as unknown rather than converted 1:1`,
      );
    }
    return converted;
  }

  /**
   * Rate arrays whose look-ahead fallback has already been logged. Keyed by the
   * per-request array object in the RateIndex, so each pair warns once per
   * computation instead of once per chart point.
   */
  private readonly lookAheadWarned = new WeakSet<
    Array<{ date: string; rate: number }>
  >();

  private findBestRate(
    rates: Array<{ date: string; rate: number }>,
    pair: string,
    beforeOrOn: string,
  ): number | undefined {
    let best: number | undefined;
    for (const r of rates) {
      if (r.date <= beforeOrOn) best = r.rate;
      else break;
    }
    // No rate on or before this date: fall back to the earliest one there is.
    //
    // This is look-ahead -- valuing a point with a rate from its future -- and
    // the time-series contract forbids it in general. It is kept deliberately
    // (DR-02 in the audit): a chart point that predates the rate history is
    // more useful approximated than absent. What is NOT acceptable is it being
    // invisible, so it is logged below; changing the fallback itself is a
    // product decision recorded in docs/specs/fx-conversion-completeness.md
    // section 6.
    if (best === undefined && rates.length > 0) {
      if (!this.lookAheadWarned.has(rates)) {
        this.lookAheadWarned.add(rates);
        this.logger.warn(
          `Valuation on or before ${beforeOrOn} predates the stored ${pair} rate history; using the earliest stored rate (look-ahead, DR-02)`,
        );
      }
      best = rates[0].rate;
    }
    return best;
  }

  private resolveStartDate(account: Account, earliest: any): string {
    if (earliest) {
      return this.toDateString(earliest);
    }
    if (account.accountType === AccountType.ASSET && account.dateAcquired) {
      return this.toDateString(account.dateAcquired);
    }
    return account.createdAt.toISOString().substring(0, 10);
  }

  private toDateString(value: string | Date): string {
    if (!value) return new Date().toISOString().substring(0, 10);
    if (typeof value === "string") return value.substring(0, 10);
    return value.toISOString().substring(0, 10);
  }

  private monthEndDate(monthFirstDay: string): string {
    const [y, m] = monthFirstDay.split("-").map(Number);
    const lastDay = new Date(y, m, 0).getDate();
    return `${y}-${String(m).padStart(2, "0")}-${String(lastDay).padStart(2, "0")}`;
  }
}
