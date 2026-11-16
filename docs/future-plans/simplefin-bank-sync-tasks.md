# SimpleFIN bank-sync tasks

- [x] Adapt the existing provider framework for setup tokens without changing Enable Banking setup.
- [x] Add encrypted credentials, durable request budget and paired schema migrations.
- [x] Add bounded transport, account discovery and reviewed import through the existing planner/writer.
- [x] Add opt-in daily batching and truthful provider balance timestamps.
- [x] Add translated settings controls and active-linked-account provider defaults with regression coverage.
- [x] Verify backend/frontend lint, types, changed tests and builds on the current upstream base.
- [x] Verify serial database integration, migration lint and schema replay.
- [x] Verify locale parity, pseudo-locales, repository manifests and contribution scope.
- [ ] Complete author review and the PR template linked to discussion #1796.

No private deployment files, financial records or investment-holdings changes belong in this contribution.

## Verification results

Full backend lint, both backend type checks, all 367 backend changed spec files and the backend production build pass. Frontend lint, types, locale checks, all 799 changed-test files (14,943 tests) and the production build pass. All 157 serial database integration suites pass (1,741 tests; eight pre-existing skips). Schema replay passes twice, and migration lint and repository documentation checks pass. No guard or test is disabled.
