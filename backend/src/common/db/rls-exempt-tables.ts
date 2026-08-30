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
  currencies:
    "Global reference data keyed by ISO 4217 code; created_by_user_id is attribution, not ownership.",
  exchange_rates:
    "Global reference data with no owner column; written by the scheduled refresh under system context.",
  market_index_prices:
    "Global market reference data with no owner column; one index close serves every user.",
  market_index_sync:
    "Sync bookkeeping for the market-index refresh; same ownership story as market_index_prices.",
  oauth_payloads:
    "OIDC provider artifacts keyed by opaque id/model/grant_id/uid, with no owner column to policy on.",
  provider_health:
    "Deployment-wide provider availability and alert bookkeeping; no owner column, one outage is every user's.",
  schema_migrations:
    "Migration infrastructure, written only by db-migrate running as the owner.",
};

/** The exempt table names, sorted, for comparison against the schema block. */
export const rlsExemptTableNames = (): string[] =>
  Object.keys(RLS_EXEMPT_TABLES).sort();
