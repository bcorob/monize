# Plan: collapse `exchange_rates` to one stored orientation

Staged plan for storing each currency pair once, in a canonical orientation,
instead of once per direction. The invariants are the approved spec
`docs/specs/exchange-rate-canonical-orientation.md`; this file is the work
breakdown, the guards and the rollout. The task graph is
`docs/future-plans/exchange-rate-canonical-orientation-tasks.md`.

## Goal

One row per pair and date, `from_currency < to_currency`, written by one helper,
with every lookup reading either direction through `resolveFxRate`.

Two rows per pair exist today because two readers ask a direction-specific
question. The mirror row is cheap in space and wrong in kind: nothing keeps the
two rows reciprocal, and when they diverge the resolver's "more recently
observed direction wins" rule silently picks between two different answers for
one date. Removing the second row removes the class.

## Maintainer decisions (2026-09-19)

| # | Question | Decision |
| --- | --- | --- |
| 1 | Scope | **The full collapse**, not the smaller inverse-aware lookup with the mirror rows kept. |
| 2 | Canonical orientation | **Lexicographic**, `from_currency < to_currency`. |
| 3 | Staging | **Two PRs**: expand, then contract in a later release. |
| 4 | Conflict rule in the migration | **The canonical row wins.** |
| 5 | The Money importer | **Canonicalises on import**, one row per pair and date. |
| 6 | GEM's own direct-then-reverse pair | **Collapsed to one lookup.** |
| 7 | The default age bound on the latest-rate lookup | **Unchanged (unbounded).** Its own decision. |

## Principles

- **One helper writes every row.** `canonicalRateRow`
  (`backend/src/currencies/canonical-rate.util.ts`) decides orientation, inverts
  at `roundFxRate` precision, and refuses a non-pair or a non-positive rate. A
  source scan holds it, because "every writer does X" is a scanning test, not a
  comment.
- **One resolver reads every row.** `resolveFxRate` already decides direct
  against inverse; the readers this touches stop restating that decision rather
  than each gaining their own copy of it.
- **Expand before contract.** The writer change ships first and deletes nothing.
  The delete and the `CHECK` ship only once the pods that write mirror rows are
  gone, per `docs/database-migrations.md`.
- **Nothing about the age bound or look-ahead changes.** A rate stays a price;
  this is about orientation only.

## Work packages

**T1, the expand release (one PR).**

- `canonical-rate.util.ts` plus its spec, and `directionlessPairKey` rebuilt on
  the same comparison so the sort rule is written once.
- `saveRate` and `persistRateSeries` in
  `backend/src/currencies/exchange-rate.service.ts` write one canonical row.
- `writeExchangeRates` in `backend/src/import/mny/writers/write-prices.ts`
  canonicalises and dedupes on the canonical triple.
- `getLatestRate` reads both directions through `resolveFxRate` in `live` mode;
  `convertOnDate` drops its dead reverse chase; the coverage probe in
  `backfillHistoricalRates` becomes directionless; `GemPositionService.convert`
  makes one lookup.
- The orientation guard, the shrunk reciprocal allowlist, and the doc updates.

**T2, the contract release (a later PR).** The data migration, `schema.sql`, the
`CHECK`, its integration spec, and INV-FX-003 to `enforced`. Fully specified in
the task file so a fresh session can execute it.

## Invariants to add

- **INV-FX-003**, a pair is stored in one orientation. `partial` after T1, when
  the guard holds the writers but old rows remain; `enforced` after T2, when the
  `CHECK` is the mechanism. Added to `docs/system-invariants.md` and
  `docs/verification-contract.md` section 3 in T1, with its status flipped in T2.

## Guards to add

- `backend/src/currencies/exchange-rate-orientation.guard.spec.ts`: an
  `INSERT INTO exchange_rates` outside the two reviewed writers, or inside one
  of them without naming `canonicalRateRow`, fails. Comments are stripped before
  matching, and the scanner is tested in both directions, per
  `docs/guard-tests.md`.
- `backend/src/common/fx-fallback.guard.spec.ts` **shrinks**: GEM leaves the
  reciprocal allowlist because it no longer reciprocates. A baseline that only
  shrinks is the point; nothing is added to it here.

## Rollout order and deployment safety

1. **T1 deploys with no migration.** New pods write canonical rows; old pods
   write both orientations. Both generations read correctly: the new readers take
   either direction, and the old readers find the mirror rows the old pods are
   still writing, plus every mirror row written before the release.
2. **T1 is left in place** until it is the only release deployed. The canonical
   rows accumulate; non-canonical rows stop growing except from old pods.
3. **T2 deploys the migration.** By then every writer is canonical, so the
   `CHECK` refuses nothing the running code writes. The delete removes rows
   nothing reads any more, because every T1 reader resolves either direction.

Reverting T1 after T2 has run would leave old code reading one direction against
canonical-only data, which is a downgrade past a contract migration and is not
supported; `docs/database-migrations.md` says the same of every contract step.

## Open questions

None outstanding. Section 11 of the spec records the seven that were answered.
Two observations were made while reading the code and are deliberately **not**
in scope here:

- The dateless posting fallbacks (`securities/investment-transactions.service.ts`,
  `scheduled-transactions/scheduled-transactions.service.ts`,
  `common/fx-entry.util.ts`) still take an unbounded latest rate. The one-door
  baseline records why, and bounding them decides whether a posting can be made
  at all.
- `backend/src/net-worth/series-rate-fill.ts` carries a second local copy of the
  directionless pair key.
