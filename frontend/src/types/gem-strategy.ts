/**
 * View contract for the GEM (Global Equities Momentum) strategy report.
 *
 * These types describe the single read model the report page consumes -- they
 * mirror the strategy data the backend evaluates and hold no business logic of
 * their own. Every derived number (momentum, spreads, ranking, transfer value,
 * tax/commission estimates) is supplied by the server so the UI never
 * recomputes the strategy.
 *
 * `null` always means "not known" -- an unmapped role, missing price history,
 * no strategy account, or a value the server could not estimate. The UI renders
 * an explicit unknown marker for those, never a zero.
 */

/** The four roles a GEM strategy assigns an instrument to. */
/** How the report decided whether a holding counts towards the target. */
export type GemCompositionBasis = "COMPOSITION" | "INSTRUMENT";

/** The breakdown a composition comparison ran on. */
export type GemCompositionDimension = "COUNTRY" | "ASSET_CLASS" | "SECTOR";

export type GemAssetRole =
  | "US_EQUITY"
  | "EX_US_EQUITY"
  | "EM_EQUITY"
  | "SAFE"
  | "RISK_FREE";

/** Absolute-momentum outcome: equities in (RISK_ON) or safe asset (RISK_OFF). */
export type GemSignalState = "RISK_ON" | "RISK_OFF";

/** How often the strategy re-evaluates its signal. */
export type GemCadence = "MONTHLY" | "QUARTERLY";

/** What a historical evaluation asked the investor to do. */
export type GemHistoryAction = "BUY" | "HOLD" | "SWITCH";

/** Selectable window for the asset-performance chart. */
export type GemRange = "3M" | "6M" | "1Y" | "3Y" | "5Y" | "MAX";

/** Conditions the server flags so the UI can explain incomplete output. */
export type GemWarningCode =
  | "UNMAPPED_ROLE"
  | "INCOMPLETE_HISTORY"
  /**
   * Periods decided under an earlier configuration of this strategy are absent
   * from the history and the backtest, because the current one cannot
   * recalculate them.
   */
  | "LEGACY_PERIODS"
  | "NO_ACCOUNT"
  | "NO_POSITION"
  | "FIRST_RUN"
  | "STALE_PRICES"
  /**
   * A required leg's price history does not reach the momentum window's start,
   * so the current period has no signal. `roles` names the legs and
   * `requiredFrom` the date their instruments need prices back to.
   */
  | "SHORT_HISTORY"
  | "CALCULATION_FAILED";

export interface GemWarning {
  code: GemWarningCode;
  /** Roles the warning applies to, when it is role-specific. */
  roles?: GemAssetRole[];
  /** How many things the warning is about, when the number is the point. */
  count?: number;
  /** For `SHORT_HISTORY`: ISO date the `roles` instruments need prices back to. */
  requiredFrom?: string;
}

/** An instrument bound to a strategy role. `symbol`/`name` are null when the role has no ETF yet. */
export interface GemAssetRef {
  role: GemAssetRole;
  securityId: string | null;
  symbol: string | null;
  name: string | null;
}

export interface GemAssetMomentum extends GemAssetRef {
  /** Trailing 12-month total return, in percent. Null when history is incomplete. */
  momentumPercent: number | null;
  /** 1-based rank among the equity assets; null for the safe asset or when unknown. */
  rank: number | null;
}

/** Step 1: equities (US) versus the risk-free asset. */
export interface GemAbsoluteStep {
  equity: GemAssetMomentum;
  /**
   * What equities were measured against: the dedicated risk-free leg when the
   * strategy assigns one, otherwise the safe asset.
   */
  benchmark: GemAssetMomentum;
  /** equity.momentumPercent - benchmark.momentumPercent in percentage points; null when either is unknown. */
  spreadPp: number | null;
  result: GemSignalState;
}

/** Step 2: the equity ranking, only decisive while RISK_ON. */
export interface GemRelativeStep {
  /** Equity assets ordered best-first. */
  ranking: GemAssetMomentum[];
  winner: GemAssetRef | null;
  /** Lead of rank 1 over rank 2, in percentage points; null when unknown. */
  leadPp: number | null;
  /** False when RISK_OFF makes the ranking irrelevant to the current allocation. */
  applied: boolean;
}

export interface GemSignal {
  id: string;
  state: GemSignalState;
  /** Instrument the strategy allocates to (equity winner, or the safe asset while RISK_OFF). */
  target: GemAssetRef | null;
  /** Target weight of the strategy portfolio in `target`, in percent (GEM uses 100). */
  targetWeightPercent: number;
  /** ISO date the signal became binding. */
  effectiveFrom: string;
  /** ISO date the signal was evaluated. */
  evaluatedOn: string;
  absolute: GemAbsoluteStep;
  relative: GemRelativeStep;
}

export interface GemAccountRef {
  id: string;
  name: string;
}

/**
 * An instrument actually held in the strategy accounts. `role` is null for a
 * holding that fills no strategy role -- the comparison covers the whole
 * portfolio, so those count towards the total and towards what a switch moves.
 */
export interface GemHeldAsset {
  role: GemAssetRole | null;
  /**
   * True for the accounts' cash balance. It is a position for compliance --
   * GEM wants everything in one instrument, so idle cash is off target -- but
   * it has no security to link to, no quantity, and is spent, not sold.
   */
  isCash: boolean;
  securityId: string | null;
  symbol: string | null;
  name: string | null;
  quantity: number | null;
  marketValue: number | null;
  /**
   * True when this holding is the instrument the signal names -- the same
   * security, not a fund with similar exposure. Decides keep or sell.
   */
  isTargetInstrument: boolean;
  /**
   * Estimated share of this holding exposed to the target's markets, 0-100, or
   * null when it cannot be estimated. Informational: a world tracker partly
   * covering an emerging-markets target is still sold whole.
   */
  matchPercent: number | null;
  /**
   * `matchPercent` is a lower bound rather than a measurement, because the
   * breakdowns describe only part of one fund or the other. Render it as "at
   * least"; a floor printed as a figure is the one reading that is wrong.
   */
  matchIsFloor: boolean;
  /** True when the ticker decided it, because no breakdown was available. */
  matchedByInstrument: boolean;
  /**
   * Which of the target's markets this holding covers, largest first, as
   * percentages of the holding. The compliance figure says a fifth of a fund
   * is on target; this says which fifth.
   */
  matchedMarkets: Array<{ name: string; percent: number }>;
}

/** Where the real portfolio stands versus the signal. */
export interface GemPosition {
  /** Brokerage accounts the position is summed across; empty when none is assigned. */
  accounts: GemAccountRef[];
  /** Everything held in those accounts, largest position first. */
  holdings: GemHeldAsset[];
  /** The largest holding -- what the accounts are effectively in; null when empty. */
  current: GemHeldAsset | null;
  target: GemAssetRef | null;
  /**
   * Share of the priced securities held in the target instrument itself,
   * 0-100; null when unknown. The operational figure: GEM asks for 100% of one
   * fund, and a different fund with exposure to the same market is not part of
   * the way there.
   */
  exactTargetPercent: number | null;
  /**
   * Estimated share of the priced securities exposed to the target's markets,
   * 0-100; null when it cannot be estimated. Informational only.
   */
  marketExposurePercent: number | null;
  marketExposureAvailable: boolean;
  /** The estimate is a lower bound: at least this much, possibly more. */
  marketExposureIsFloor: boolean;
  marketExposureDimension: GemCompositionDimension | null;
  changeRequired: boolean;
  /** Market value of everything held in the accounts; null when nothing can be priced. */
  totalMarketValue: number | null;
  /** Whether contents or tickers decided compliance. */
  basis: GemCompositionBasis;
  /** Breakdown the contents were compared on; null when tickers were used. */
  dimension: GemCompositionDimension | null;
  /** The breakdown the target would need for a contents comparison. */
  requiredDimension: GemCompositionDimension | null;
  /** How many holdings fell back to a ticker comparison. */
  instrumentMatchedCount: number;
  currencyCode: string;
}

/** The single operation the strategy asks for, with the server's cost estimates. */
export interface GemAction {
  /** False when the portfolio already matches the signal. */
  required: boolean;
  /**
   * Every security the operation sells, largest first. Empty for a purchase
   * funded by cash alone. Cash is never in here: nobody places a trade to sell
   * it.
   */
  sellPositions: GemHeldAsset[];
  to: GemAssetRef | null;
  /** Target weight of the destination instrument, in percent. */
  targetWeightPercent: number;
  /** Estimated value to move, in `currencyCode`; null when it cannot be estimated. */
  transferValue: number | null;
  /** Estimated realized gain (positive) or loss (negative) on the sale. */
  realizedGainLoss: number | null;
  /** Estimated tax on the realized gain; null when not applicable or unknown. */
  estimatedTax: number | null;
  /** Tax rate behind `estimatedTax`, in percent; null when unknown. */
  taxRatePercent: number | null;
  /** Estimated broker commission for every trade the switch takes; null when unknown. */
  estimatedCommission: number | null;
  /** Trades the switch takes: one sell per off-target holding, plus the buy. */
  estimatedTradeCount: number;
  /**
   * How many sold holdings were already partly in the target's markets. They
   * count towards compliance but are still sold whole, so the transfer is
   * larger than the off-target share alone suggests.
   */
  partialMatchCount: number;
  /** Brokerage accounts the operation spans; empty when none is assigned. */
  accounts: GemAccountRef[];
  currencyCode: string;
  /** True once the user marked this signal's operation as executed. */
  executed: boolean;
}

export interface GemPerformancePoint {
  /** ISO date of the observation. */
  date: string;
  /** Cumulative total return per role since the start of the range, in percent. */
  values: Partial<Record<GemAssetRole, number | null>>;
}

/** Why the current-composition simulation has no line. */
export type GemSimulationUnavailableReason =
  | "NO_HOLDINGS"
  | "UNKNOWN_CURRENT_VALUE"
  | "MISSING_PRICE_HISTORY";

/**
 * Today's holdings, in today's proportions, replayed over the window.
 *
 * A hypothetical, never the user's realised performance: no transactions, no
 * deposits or withdrawals, no cash, no currency movement, no costs, and no
 * rebalancing after the first day.
 */
export interface GemCurrentPortfolioSimulation {
  points: Array<{ date: string; returnPercent: number | null }>;
  totalReturnPercent: number | null;
  /** False when the line starts later than the window the user asked for. */
  completeRange: boolean;
  startsOn: string | null;
  /**
   * Last date the line reaches when that is before the chart's own last point;
   * null when it runs to the end.
   */
  endsOn: string | null;
  /** The instruments whose prices ran out there. Empty when none did. */
  stoppedBy: string[];
  includedHoldings: Array<{
    securityId: string;
    symbol: string | null;
    weightPercent: number;
  }>;
  /** Set when there is no line at all; the UI says which of the three it is. */
  unavailableReason: GemSimulationUnavailableReason | null;
}

export interface GemPerformance {
  range: GemRange;
  points: GemPerformancePoint[];
  /** Cumulative total return per role at the end of the range, in percent. */
  totals: Partial<Record<GemAssetRole, number | null>>;
  /** True when at least one asset lacks prices for the whole range. */
  incomplete: boolean;
  /** Today's holdings replayed over the window; null when none are held. */
  currentPortfolio: GemCurrentPortfolioSimulation | null;
}

export interface GemHistoryEntry {
  id: string;
  /** ISO date of the evaluation. */
  evaluatedOn: string;
  /** ISO date the resulting signal became binding. */
  effectiveFrom: string;
  winner: GemAssetRef | null;
  state: GemSignalState;
  action: GemHistoryAction;
  /** Trailing 12-month momentum per role at evaluation time, in percent. */
  momentum: Partial<Record<GemAssetRole, number | null>>;
  /** Instrument change the evaluation implied; null when the allocation was unchanged. */
  change: { from: GemAssetRef | null; to: GemAssetRef | null } | null;
  /** Whether the user carried the change out; null when there was nothing to do. */
  executed: boolean | null;
}

/** Net-of-cost backtest summary for the configured asset set. */
export interface GemBacktestSummary {
  /** ISO dates bounding the simulated period. */
  from: string;
  to: string;
  /** Compound annual growth rate, in percent. */
  cagrPercent: number | null;
  /** Worst peak-to-trough decline, in percent (negative). */
  maxDrawdownPercent: number | null;
  /**
   * Share of the simulated periods whose signal beat the safe asset, in
   * percent. Null unless every simulated period could be compared.
   */
  hitRatePercent: number | null;
  /**
   * Whether the configured tax rate was deducted from the figures, and whether
   * the configured commission was. Separate flags because the two fail
   * independently: an absolute commission needs a known portfolio total to
   * become a drag, a tax percentage does not. Both are false for a truncated
   * run (`coveragePercent` below 100).
   */
  taxApplied: boolean;
  commissionApplied: boolean;
  /**
   * Share of the evaluated periods the simulation covers, 0-100. Below 100 the
   * earlier periods are excluded from the run, not held flat: the simulation
   * is the most recent unbroken stretch of priced periods and `from` says
   * where it starts.
   */
  coveragePercent: number;
}

/** One saved scenario, for the report's switcher. */
export interface GemStrategyRef {
  id: string;
  name: string;
}

export interface GemStrategyMeta {
  /**
   * The saved scenario's id, or null before the first save: the report shown
   * to a user with no strategy describes one that does not exist yet. Never
   * send a null id back to the API -- omit the parameter instead.
   */
  id: string | null;
  /** Scenario name shown in the switcher and the report title. */
  name: string;
  cadence: GemCadence;
  /** Momentum lookback window in months. */
  lookbackMonths: number;
  /** Tax rate behind the transfer estimates, in percent; null when unset. */
  taxRatePercent: number | null;
  /**
   * Commission assumption per trade; null when unset. A switch out of two
   * holdings is three trades and is charged three times this amount.
   */
  commissionAmount: number | null;
  /** ISO date of the next scheduled evaluation; null when unscheduled. */
  nextEvaluationOn: string | null;
  /** Whole days until `nextEvaluationOn`; null when unscheduled. */
  daysUntilNextEvaluation: number | null;
  /** ISO timestamp of the price data behind the report; null when no prices exist. */
  pricesAsOf: string | null;
  /** Where the strategy rules are documented (shown in the report footer). */
  rulesSourceUrl: string | null;
  rulesSourceLabel: string | null;
  /** Brokerage accounts the strategy trades in; their holdings are summed. */
  accounts: GemAccountRef[];
}

/** Everything the GEM report page renders, in one read. */
export interface GemStrategyReport {
  strategy: GemStrategyMeta;
  /** Every saved scenario, so the switcher can offer them. */
  strategies: GemStrategyRef[];
  /** All four roles, in strategy order. `symbol` is null for an unmapped role. */
  assets: GemAssetRef[];
  /** Null when the signal could not be evaluated (first run, failed calculation). */
  signal: GemSignal | null;
  position: GemPosition | null;
  action: GemAction | null;
  performance: GemPerformance | null;
  /** Newest evaluation first. */
  history: GemHistoryEntry[];
  backtest: GemBacktestSummary | null;
  warnings: GemWarning[];
}

/** One role assignment sent to the configuration endpoint. */
export interface GemAssetAssignmentInput {
  role: GemAssetRole;
  /** null clears the assignment, leaving the role unmapped. */
  securityId: string | null;
}

/**
 * Payload for PUT /strategies/gem. Every field is optional: omitting one leaves
 * the stored value alone, while sending `null` clears it.
 */
export interface GemStrategyConfigInput {
  /** Replaces the whole account set; an empty array unassigns every account. */
  accountIds?: string[];
  cadence?: GemCadence;
  lookbackMonths?: number;
  taxRatePercent?: number | null;
  commissionAmount?: number | null;
  rulesSourceUrl?: string | null;
  rulesSourceLabel?: string | null;
  assets?: GemAssetAssignmentInput[];
}
