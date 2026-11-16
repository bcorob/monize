# Money 97-99 `.mny` import: agent task list

> Companion to [`mny-money99-import.md`](./mny-money99-import.md) (the plan). One task per session and PR, in dependency order. "The plan" means that file; its tables are the authority on every code, mask and balance. Re-locate code by symbol, never by line.

## How to use this list

- **Order is a safety property.** The model changes (B1) land before the door opens (B2): a Money 99 file that reaches the mappers before B1 imports voided rows as live, pending instances as posted, and sales as purchases, and the verification report cannot tell, because the mapper and the report agree with each other.
- **Expected numbers come from the plan's ground-truth table**, which is Money 99's own account list, never from the importer's output.
- **Definition of done for every task:** in `backend/`, `npm run lint && npx tsc --noEmit && npm run typecheck` and `npm run test:changed`; in `frontend/` when touched, `npm run lint && npm run type-check && npm run i18n:check`, `npm run test:changed`, `npm run build`; for docs, `node scripts/check-docs-manifests.mjs` and `npm run test:unit -- doc-paths instruction-files` in `backend/`. Stage new files before running a guard. New strings in English only, then `npm run i18n:pseudo`; other locales are task Q.
- A mask or code not in the plan's tables is not added by any task here. A real file that contradicts the plan updates the plan first, in its own commit.

## Deployment safety

| Class | Meaning |
|---|---|
| **none** | Docs or tests only. |
| **inert** | Code no uploaded file can reach yet: every file opened today reports the `msisam` format. |
| **live** | Changes what an upload does. |

## Task graph

| ID | Task | Depends on | Class | Status | PR |
|---|---|---|---|---|---|
| S1 | Plan pair; amend `docs/specs/mny-import.md` (Money 97/98 rejection becomes Money 97-99 support, link the plan) | -- | none | [x] | branch `feat/mny-money99-import` |
| B1 | Per-format codes: flag translation and action table | S1 | inert | [x] | branch `feat/mny-money99-import` |
| B2 | Open Jet 3 files; `money99` era; fixture and end-to-end balances | B1, D1 | live | [x] | branch `feat/mny-money99-import` |
| B3 | Scheduled bills from `TRN` templates when there is no `BILL` table | B2 | live | [x] | branch `feat/mny-money99-import` |
| Q | Locales and user guide | B2 (B3 if merged) | none | [x] | branch `feat/mny-money99-import` |

## S1: spec amendment

Files: `docs/specs/mny-import.md`, this plan pair. Replace the out-of-scope line for Money 97/98 and the "explicit unsupported-version message" acceptance line with a pointer to the plan. No code.

## B1: per-format codes

Files: `backend/src/import/mny/msisam/open-mny.ts`, `backend/src/import/mny/tables/read-transactions.ts`, `backend/src/import/mny/tables/money99-transactions.ts`, `backend/src/import/mny/model/mny-money99.ts`, `backend/src/import/mny/model/mny-actions.ts` (the action section of `mny-model.ts`, split out to keep that file under 800 lines), `backend/src/import/mny/model/mny-model.ts`, `backend/src/import/mny/map/map-investments.ts`, `backend/src/import/mny/map/map-bills.ts`, their specs, `backend/src/import/mny/README.md`, `docs/ms-money-data-model.md`.

1. `MnyDatabase.format: "msisam" | "jet3"`; `openDatabase` sets `msisam` for every file today.
2. `readTransactionData` carries the format on `MnyTransactionData`. For `jet3` it rebuilds `flags` from the plan's measured Money 99 bits into the Money Plus layout, and drops every other bit: an unknown Money 99 bit passed through could land on a Plus mask (the loan-template bit *is* Plus VOID).
3. A Money 99 action table beside `ACTION_BY_CODE` with the plan's confirmed codes. `mapInvestmentAction`, `MNY_UNCONFIRMED_ACTIONS` and `hasInvestmentDetail` take the format; Money Plus behaviour is unchanged.
4. D2 and D3 as decided.

Tests (unit, fake database): every row of the plan's `grftt` table in both directions; an unknown Money 99 bit does not survive translation; each confirmed action code; a Money Plus row is unchanged (a regression case for `act` 1 = BUY and `grftt` 0x100 = VOID). README: a "Money 99 is a different code space" trap entry.

Acceptance: no Money Plus fixture output changes (the existing suites pass unmodified).

## B2: open Jet 3 files

Files: `backend/src/import/mny/msisam/jet-header.ts`, `backend/src/import/mny/msisam/msisam-decrypt.ts`, `backend/src/import/mny/msisam/open-mny.ts`, `backend/src/import/mny/mny-parser.service.ts` (`MnyEra` gains `money99`), `backend/src/import/mny/mny-inspect.ts`, `backend/src/import/mny/__fixtures__/` (the D1 file and its `mny-fixtures.ts` entry), `frontend/src/lib/import-mny.ts`, `frontend/src/i18n/messages/en/import.json` (`mnyReview.era.money99`, and the `mnyUnsupportedVersion` text), `backend/src/i18n/locales/en/errors.json`, specs.

1. `readMnyFileHeader` accepts `Standard Jet DB` with version byte 0 and returns `format: "jet3"`; decryption is a no-op for it; a password supplied for it is ignored.
2. `openDatabase` rejects a `jet3` file lacking `ACCT`, `TRN` or `DHD` with `MnyNotAMoneyFileError`.
3. The staged-bytes path (`openDecryptedMnyFile`) reopens a `jet3` file unchanged.
4. Era `money99` for `jet3` files.

Tests: header cases (Jet 3 Money, Jet 3 without Money tables, unknown version byte); parse the fixture through the real staging path (`POST /parse` bytes, then the job's re-read) and assert the plan's ground truth: per-account balances including future-dated posted rows, holdings 11 and 0, the voided row imported VOID, no pending instance or loan-template row imported, row and transfer counts.

Acceptance: `npm run mny:inspect` on the fixture prints the ground-truth balances with no `holdingsMismatch`.

## B3: bills from `TRN` templates

Files: `backend/src/import/mny/tables/read-bills.ts`, `backend/src/import/mny/tables/read-transactions.ts` (read `htrnSrc`), `backend/src/import/mny/map/map-bills.ts`, specs.

When the file has no `BILL` table, one candidate per `frq != -1` template that names its pending instance in `TRN.htrnSrc` (one bill per scheduled transfer, from its outgoing leg; the reader does not keep the `0x800` origin bit), dated from its pending instance (`htrnSrc`), through the existing cadence, activity and roll-forward rules. The loan-payment template family stays excluded as today.

Tests: the fixture holds five series (card payment, loan payment, transfer to investment cash, salary, "Actos culturales"), each read once, monthly. The scheduled loan payment (the split template whose leg pays the loan account) is a series, not the `0x100` loan-template family, but Money 99 recorded no paying account on it, so it is reported as `unusableBill` and four bills import.

## Q: acceptance

Translate every new string into every locale; `docs/import-ms-money.md` names Money 97-99 as supported and drops the resave instruction. Release notes are drafted when a release is cut (`docs/release-notes/README.md`), so none is committed here.
