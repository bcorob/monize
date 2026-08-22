-- Issue #1242: historical portfolio valuation ignored manual and imported
-- prices for securities flagged skip_price_updates. The monthly snapshot
-- recalculation (net-worth) valued such securities from raw transaction prices
-- instead of the accepted security_prices close, so monthly_account_balances
-- persisted an understated market_value for every account holding one -- e.g. a
-- 401(k) reporting 120 shares * $61 = $7,320 when the accepted close was $120
-- ($14,400).
--
-- The valuation code is corrected to read accepted security_prices for every
-- security regardless of skip_price_updates (that flag now governs external
-- price FETCHING only). The snapshots already persisted under the old rule stay
-- wrong until something recomputes them: the debounced per-account recalc only
-- fires on an edit, and the stale-snapshot sweep deliberately skips accounts
-- whose snapshots merely disagree (it looks for snapshots older than their
-- account row, which an upgrade does not change). So delete the affected derived
-- rows here; NetWorthService.ensurePopulated / refreshStaleAccountsForCurrentMonth
-- rebuilds them from the corrected algorithm on the next net-worth read.
--
-- Bounded to investment accounts -- the only accounts whose market_value the
-- valuation code computes at all, so the only ones the old branch could have
-- got wrong. Deliberately NOT narrowed to securities currently flagged
-- skip_price_updates: SecuritiesService.update clears that flag when the user
-- assigns a quote provider, so a snapshot computed while the flag was true can
-- outlive it (review MZ-1242-R3, secondary gap). Derived data only: no source
-- transaction and no accepted price row (security_prices) is touched.
--
-- Idempotent by construction: monthly_account_balances is derived, so a
-- re-applied DELETE either matches the same rebuilt rows (harmless -- they are
-- rebuilt again) or matches nothing on a database with no such accounts (a
-- fresh schema.sql install), so it is a safe no-op on replay.
DELETE FROM monthly_account_balances mab
 USING accounts a
 WHERE mab.account_id = a.id
   AND a.account_type = 'INVESTMENT';
