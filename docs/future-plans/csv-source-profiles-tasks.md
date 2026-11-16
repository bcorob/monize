# CSV source profiles: agent task list

> Companion to [`csv-source-profiles.md`](./csv-source-profiles.md). One task per session and per PR, in dependency order. No task starts before S1.

## How to use this list

- **No task starts before S1**: the discussion carries `approved-to-build` and the open questions C1 to C3 are answered.
- **The governing invariants apply to every task**: P1 (a captured split sums or the row is refused), P2 (no duplicate twice), P3 (preview equals commit). A task that invents a rounding line, or writes a row the preview did not show, is wrong: stop.
- **An existing saved mapping imports exactly as before.** Every task keeps that test green.
- **Definition of done**: the layer gates of `AGENTS.md`; migrations with `migration:lint`, `scripts/verify-schema.sh` and `node scripts/check-migration-prefixes.mjs`; strings in every locale; the PR body per `.github/pull_request_template.md`.

## Task graph

| ID | Task | Depends on | Deploy impact | Status |
|----|------|-----------|---------------|--------|
| S1 | Discussion approved; C1 to C3 answered; this plan merged | -- | none | [ ] |
| P1 | Browser decoding with an encoding allowlist; the profile stores the encoding and the decimal separator | S1 | inert | [ ] |
| P2 | Profile content in `import_column_mappings` (positional and labelled columns, operation-type column, per-type mapping, default mapping); parser support; compatibility test | S1 | inert | [ ] |
| P3 | Duplicate key: migration for the key column, key function shared by preview and commit, check inside the import transaction; cut-off date | P2 | neutral | [ ] |
| P4 | Transfer rules on labels and title (extends `CsvTransferRule`) | P2 | inert | [ ] |
| P5 | Split rules from captured amounts, sum check with scaled integers, refusal naming the difference | P2, rules X1 | inert | [ ] |
| P6 | Preview: per-row plan, missing labels, duplicates, cut-off, rule effects; commit refuses a changed plan by fingerprint | P3, P4, P5, rules X4 | inert | [ ] |
| P7 | Profile editor in the import wizard (Home Assistant style cards for types, transfer rules and split rules, reusing the rules editor pickers) | P2 | inert | [ ] |
| P8 | Documented example profile for a PKO BP-shaped export in `docs/`, synthetic data | P6, P7 | none | [ ] |
