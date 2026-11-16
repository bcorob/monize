# SimpleFIN bank-sync implementation plan

Approved scope: [discussion #1796](https://github.com/kenlasko/monize/discussions/1796). Follow `docs/specs/simplefin-bank-sync.md` and the existing bank-sync provider, preview, planner and writer framework.

Add setup-token credentials, bounded HTTPS transport, account discovery, reviewed transaction import and opt-in daily synchronization. Preserve Enable Banking routes and behavior. Keep investment holdings, trades, pending imports and automatic opening-balance adjustments outside this contribution.

Backend work is under `backend/src/bank-sync/`, with paired additive migrations and `database/schema.sql`. Frontend work is under the Bank Sync settings page and components, API clients and types. Provider defaults follow active linked accounts; an explicit selection wins for the current visit. All user-facing messages use the existing locale catalogs.

Verify with isolated synthetic databases and public demo fixtures. Run lint, both backend type checks, frontend type checks, changed tests, builds, i18n checks, migration lint, schema replay and serial integration tests. Do not require real credentials. Preserve guard thresholds and unrelated source.

The paired task list records verification for this contribution rather than deployment history.
