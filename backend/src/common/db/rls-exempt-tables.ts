/**
 * The tables deliberately left without a row-level-security policy.
 *
 * This list is the reason it exists: it was written out four times -- in
 * `database/migrations/114_rls_policies_special.sql`, in the exemption block at
 * the foot of `database/schema.sql`, and once in each of the two RLS
 * integration specs -- and had already drifted. The migration documented four
 * tables while the schema and both specs carried six (`market_index_prices` and
 * `market_index_sync` arrived later and reached only three of the four sites),
 * one spec asserted the count in its own name (`leaves the four exempt tables
 * untouched`) for a list of six, and the migration claimed "the catalog-driven
 * test in T2 asserts this exact list" when by then it asserted a different one.
 *
 * Both specs need a live PostgreSQL, so none of that ran in `npm run test:unit`
 * and nothing failed. `rls-exempt-tables.spec.ts` checks this constant against
 * the schema's block in both directions with no database at all.
 *
 * The rationale for each entry is `docs/row-level-security-contract.md`. Keep
 * the reasons here to one line: the contract carries the long form, and a
 * paragraph repeated in two places is how the previous four copies diverged.
 */
export const RLS_EXEMPT_TABLES: Readonly<Record<string, string>> = {
  auth_attempt_counters:
    "Rate-limit and lockout counters keyed by opaque scope/key hash; no owner column, written on the failure path before any identity is established.",
  auto_backup_policy:
    "Singleton deployment automatic-backup policy (one schedule, folder and retention per instance); no owner column, and putting it on an administrator's row is what let an ordinary account operation rewrite it.",
  benchmark_series:
    "Global reference data with no owner column; one benchmark series (policy rate, CPI) serves every account and every country's instrument.",
  benchmark_values:
    "Global reference data with no owner column; one published benchmark observation serves every account, same story as exchange_rates.",
  bond_instruments:
    "Global reference data with no owner column; one bond instrument serves every account, whatever the issuer country.",
  bond_programs:
    "Global reference data with no owner column; one bond program (the product, e.g. EDO) serves every account and every security that links to it, insert only (INV-BOND-001).",
  bond_period_rates:
    "Global reference data with no owner column; one instrument's published period rate serves every account, immutable (INV-BOND-001).",
  bond_terms_versions:
    "Global reference data with no owner column; one instrument's published terms serve every account, immutable (INV-BOND-001).",
  currencies:
    "Global reference data keyed by ISO 4217 code; created_by_user_id is attribution, not ownership.",
  exchange_rate_coverage:
    "Global record of what a rate provider carries per currency pair and where the next history fill resumes; no owner column, one provider's history serves everybody.",
  exchange_rates:
    "Global reference data with no owner column; written by the scheduled refresh under system context.",
  fetch_sync:
    "Deployment-wide leases for the jobs one replica should run per tick (the three market-data fetches and the attachment relocation pass); no owner column, one FX rate serves everybody.",
  google_places_instance_usage:
    "Request counter for the operator's own Google Places key; no owner column, one key is one bill.",
  http_throttle_counters:
    "HTTP rate-limit counters keyed by the throttler's own opaque sha256; no owner column, written by a guard that runs before any identity exists.",
  market_index_prices:
    "Global market reference data with no owner column; one index close serves every user.",
  market_index_sync:
    "Sync bookkeeping for the market-index refresh; same ownership story as market_index_prices.",
  oauth_instance_config:
    "Singleton deployment OIDC signing identity (one JWKS per instance); no owner column, one issuer signs for every account.",
  oauth_payloads:
    "OIDC provider artifacts keyed by opaque id/model/grant_id/uid, with no owner column to policy on.",
  provider_health:
    "Deployment-wide provider availability and alert bookkeeping; no owner column, one outage is every user's.",
  push_chart_artifacts:
    "Ephemeral pre-rendered images authorized by HMAC bearer tokens, consumed atomically once; no owner-facing query surface.",
  push_instance_config:
    "Singleton deployment push identity (one VAPID key pair per instance); no owner column, one identity is every user's.",
  schema_migrations:
    "Migration infrastructure, written only by db-migrate running as the owner.",
  single_use_tokens:
    "One-shot claims keyed by purpose and a SHA-256 hash; no owner column, and the hash is what keeps the shared table from being replayable.",
  update_check_state:
    "Singleton record of what this deployment last learned about the upstream release; no owner column, one instance checks one upstream.",
};

/** The exempt table names, sorted, for comparison against the schema block. */
export const rlsExemptTableNames = (): string[] =>
  Object.keys(RLS_EXEMPT_TABLES).sort();
