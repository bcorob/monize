import {
  TableRules,
  drop,
  jsonb,
  keep,
  mask,
  scale,
} from "./support-backup-rule-kinds";

/**
 * The planning tables' de-identification rules: Monte Carlo scenarios and their
 * cash flows, and the GEM strategies, their accounts, assets and signals.
 *
 * Split out of `support-backup-rules.ts` when adding one more table pushed that
 * file past the repository's 800-line ceiling. A separate area from the account
 * core -- nothing here is a ledger row -- and it is merged back into the one
 * `RULES` map, so the golden test still reads a single registry and a column
 * with no rule is still dropped.
 */
export const PLANNING_RULES: Record<string, TableRules> = {
  monte_carlo_scenarios: {
    id: keep,
    user_id: keep,
    name: mask,
    description: drop,
    account_ids: keep, // UUID array, remapped + scoped by closure
    starting_value: scale,
    use_current_balance: keep,
    years_to_retirement: keep,
    annual_contribution: scale,
    contribution_growth_rate: keep, // rate
    years_in_retirement: keep,
    annual_withdrawal: scale,
    expected_return: keep,
    volatility: keep,
    inflation_rate: keep,
    show_real_values: keep,
    use_historical_returns: keep,
    simulation_count: keep,
    target_value: scale,
    random_seed: keep,
    is_favourite: keep,
    sort_order: keep,
    last_run_at: keep,
    created_at: keep,
    updated_at: keep,
  },
  monte_carlo_cash_flows: {
    id: keep,
    scenario_id: keep,
    name: mask,
    amount: scale,
    flow_type: keep,
    start_year: keep,
    end_year: keep,
    inflation_adjust: keep,
    sort_order: keep,
    created_at: keep,
    updated_at: keep,
  },
  gem_strategies: {
    id: keep,
    user_id: keep,
    name: mask,
    cadence: keep,
    lookback_months: keep,
    tax_rate_percent: keep, // a rate, not an amount
    commission_amount: scale,
    // The rules link and its label are free text the user types into the
    // settings tab; a URL beside a masked scenario name re-identifies nothing
    // useful for a bug report.
    rules_source_url: drop,
    rules_source_label: drop,
    created_at: keep,
    updated_at: keep,
  },
  gem_strategy_accounts: {
    id: keep,
    user_id: keep,
    strategy_id: keep,
    account_id: keep,
    created_at: keep,
  },
  gem_strategy_assets: {
    id: keep,
    user_id: keep,
    strategy_id: keep,
    role: keep,
    security_id: keep,
    created_at: keep,
    updated_at: keep,
  },
  gem_strategy_signals: {
    id: keep,
    user_id: keep,
    strategy_id: keep,
    evaluated_on: keep,
    effective_from: keep,
    state: keep,
    target_role: keep,
    target_security_id: keep,
    target_weight_percent: keep, // a share, not an amount
    momentum: jsonb("gemMomentum"),
    spread_pp: keep, // percentage points
    lead_pp: keep, // percentage points
    previous_role: keep,
    benchmark_role: keep,
    // A hash of the strategy's own settings. It identifies nothing about the
    // user, and dropping it would make every restored signal look stale and be
    // recomputed on the first read.
    config_fingerprint: keep,
    // Which version of the evaluation code wrote the row. Structural, says
    // nothing about the user, and dropping it defaulted every restored signal
    // to version 1 -- which the reader then files as legacy history and leaves
    // out of the report entirely.
    algorithm_version: keep,
    executed: keep,
    executed_at: keep,
    created_at: keep,
  },
};
