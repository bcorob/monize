# Native Microsoft Money (.mny) Import: Assessment and Agent Task List

> Design + task breakdown for importing complete Microsoft Money `.mny` files through the Import
> Transactions wizard, using only Monize-native TypeScript (no Python, no Java, no mdbtools, no
> shell pipelines). Supersedes the approach in PR #192 (`poc/import-from-dotmny`) while preserving
> everything that proof of concept learned. Written 2026-07 after a full review of PR #192, its
> comment thread, issue #173, and external research into the .mny format.

## 1. Summary

Microsoft Money `.mny` files are Jet 4 Access databases in a Money-specific variant ("MSISAM"),
RC4-encrypted even when the user never set a password. PR #192 proved a full-fidelity migration is
achievable — two users migrated 25–32 years of data — but did it with an out-of-app toolchain:
a Java JAR (sunriise) to decrypt, `mdb-export` (mdbtools, C) to dump CSV, and a standalone
`migrate.ts` writing raw SQL straight into Postgres. That shape can never ship: it bypasses the
app, deletes all user data unconditionally, needs Java + mdbtools + manual npm installs, and its
data mapping had real bugs (loans, bills, investments — detailed in section 3).

This plan replaces the toolchain with a native pipeline inside the backend:

```
.mny upload (wizard) -> msisam-decrypt.ts (pure TS, ~100 lines) -> vendored mdb-reader (MIT, pure JS)
  -> tolerant table readers -> pure mapping functions -> batched writer (withScopedDb)
  -> verification report (file-computed balances vs imported balances)
```

The critical enabler, verified during research: the npm package `mdb-reader` v3.2 already parses
Jet 4 and even *detects* the MSISAM engine string — it only lacks the MSISAM decryption step, and
that algorithm (documented by the jackcess-encrypt project, Apache-2.0) is small: an SHA-1/MD5
password digest plus salt, RC4 per page, and **only file pages 1..0xE are encrypted**. A ~100-line
TypeScript pre-decryptor makes the stock reader work on `.mny` files.

The import runs as a background job with wizard progress polling (a 37k-transaction file cannot
finish inside the current synchronous 300 s import window), stages the decrypted file in the
database so any backend replica can run the job, and ends with a per-account **verification
report** comparing balances computed from the Money file against what landed in Monize — the
trust-builder both PR testers said they needed.

## 2. Goals and non-goals

### Goals

- Import a `.mny` file end-to-end from the existing Import Transactions wizard (`/import`):
  accounts (all types, closed/favourite flags, per-account currencies), payees, categories,
  transactions (splits, transfers, statuses, reference numbers), securities, investment
  transactions, security price history, exchange-rate history, and active scheduled bills.
- Fix every data-quality issue raised on PR #192 (section 3 table).
- Support Money 2001 through Money Plus Sunset file layouts, degrading gracefully when tables
  are absent (Money 2001 has no `BILL` table).
- Pure TypeScript; no new native dependencies; complies with the RLS ratchet (`withScopedDb` only).
- Verification report so users can trust the migration without hand-reconciling 56 accounts.

### Non-goals (v1, documented in UI copy and user docs)

- Merging into an already-populated profile with transaction-level dedupe. v1 targets a fresh
  profile, or an explicit opt-in wipe using the existing delete-my-data operation. Accounts are
  still find-or-create by name, so a re-import into a wiped profile is clean.
- Money budgets (`BGT` tables — no clean mapping to Monize budgets), savings goals (no Monize
  entity), classifications beyond standard categories, embedded attachments.
- Writing `.mny` files, or reading `.mbf` backup archives.
- Money 97/98 files (Jet 3 era). Detect and reject with a clear message suggesting an upgrade
  through the free Money Plus Sunset edition (which opens and converts old files).

## 3. Assessment of PR #192

### What the PoC got right (keep all of this)

Credit to marksimpson: the PoC's real contribution is the reverse-engineered schema knowledge in
`poc/import-from-dotmny:migration/ms-money-data-model.md` (a path in that branch, not this one) — table relationships, the `act` action-code semantics
(including the misleading act=16), the phantom-transaction taxonomy, and the LOT table as the
authoritative holdings source. Task M4.5 adopts that document into `docs/` (with attribution)
as the living format reference (now `docs/ms-money-data-model.md`, with the corrections below called out inline against the original). Also correct and carried forward:

- Money account type map (`at` 0..6) and the `hacctRel` investment/cash account pairing, which
  matches Monize's linked INVESTMENT_CASH + INVESTMENT_BROKERAGE pair exactly.
- Cleared-status map (`cs` 0/1/2 -> UNRECONCILED/CLEARED/RECONCILED). Voided detection was
  **not** correct: the reference's `grftt` bit 0x80 is the debt-account bit, and the void bit is
  0x100 (measured in Phase 4 against a real Money Plus file; see `docs/ms-money-data-model.md`).
- Phantom exclusions: bill template transactions (referenced by `BILL.lHtrn`), orphaned transfer
  sides, and split children (`TRN_SPLIT.htrn` rows) must not be imported as standalone rows.
- Currency resolution through `CRNC.szIsoCode`; `SP` price dedup by `(hsec, dt)`; additive
  exchange-rate import.
- Sorting categories by `nLevel` so parents exist before children.

### Issues raised in the PR thread, with root causes and the fix in this design

| # | Issue (reporter) | Root cause | Fix in this design |
|---|---|---|---|
| 1 | Loans/mortgages import with zero transactions; the principal split on the payment shows blank (kenlasko) | Two compounding bugs: (a) the phantom filter excluded `grftt & 0x8000` (auto-entered) rows — but Money marks scheduler-posted loan payments auto-entered, so the loan-side rows vanished; (b) splits were imported as category-only rows, so a split leg that is really a transfer to the loan account lost its transfer nature | Narrow the phantom rule to `frq != -1` only (auto-entered rows are real postings). Import a `TRN_SPLIT` child that appears in `TRN_XFER` as a Monize **transfer split** (`transaction_splits.kind = 'transfer'`, `transfer_account_id` = loan account, `linked_transaction_id` = the loan-side transaction, which is imported once, not duplicated). Interest/escrow legs stay category splits. Validate with the loan scenario in M1.4 and against real files in M3.4 |
| 2 | 1,844 scheduled bills imported when ~20 are real; all then bulk-deactivated (kenlasko) | `BILL` accumulates decades of rows; the PoC imported every row then marked past-due ones inactive | Import only bills detected as active series (`st` status + next-due-date sanity horizon + per-series dedupe — exact semantics pinned by the Phase 0 spike against the known "~20 real" ground truth), and show them as a **checkbox list in the wizard**; unchecked bills are simply not imported. Nothing is created inactive |
| 3 | Junk payees `#` and `*` with zero transactions; never-used categories such as `alimony` (kenlasko) | Money seeds a default category tree and keeps degenerate payee rows; the PoC imported all of `PAY`/`CAT` | Referenced-only import (default on, wizard toggle): only payees/categories referenced by an imported transaction, split, or selected bill are created. Degenerate payee names (`#`, `*`, empty after trim) always skipped. Skip counts shown in the report |
| 4 | Investment accounts "a mess": share counts wrong, negative positions, cost basis nonsense (kenlasko; marksimpson confirmed buy/sell subtleties and FX cost-basis storage quirks) | Four distinct causes: act=16 mapped to SELL (it closes lots but is a *transfer-out*, and mapping it to SELL corrupts average cost); act=4 dividends have **no TRN_INV row** so iterating TRN_INV dropped them entirely; `SEC_SPLIT` (stock splits) ignored, so every post-split position is wrong; qty-sign/action inference inconsistencies | Complete act map driven from TRN not TRN_INV (section 8.4): 4 -> DIVIDEND from `TRN.amt` (superseded: issue #1149 named `act` 4 as Money's "Interest" activity, and it now maps to INTEREST -- still cash-only from `TRN.amt`); 16 -> REMOVE_SHARES, or paired with the matching act=15 row (same date+security+qty across accounts) into linked TRANSFER_OUT/TRANSFER_IN; **SEC_SPLIT -> no transaction** (superseded: this row originally read "SEC_SPLIT -> SPLIT transactions", which contradicts what the implementation does and what this document itself says further down -- Money does not apply those ratios to its own share counts, so applying them makes the import disagree with the file. Non-unit ratios surface as verification warnings instead. See the `SEC_SPLIT` paragraph in section 8.4 and `backend/src/import/mny/README.md`); quantity always positive, direction only from act. Holdings produced exclusively by the existing `HoldingsService.rebuildAccountsFromTransactions`. Independently, the mapper computes expected holdings from **LOT open lots** (`htrnSell` empty) and flags disagreements in the verification report instead of silently corrupting positions. Foreign-currency cost basis (Money stores base-currency value at the historical rate) is surfaced as report warnings and documented as a v1 limitation |
| 5 | Money 2001 file crashed on the missing `BILL` table; needed hand-patched `tableExists` (gerardfarrell11) | Reader assumed the Sunset-era table set | Every table access goes through `getTableOrNull`; every column read has a declared default; a per-version column-presence matrix (built in Phase 0 from the 2001/2002/2008 fixtures) is encoded in the row-reader layer. Missing `BILL`/`SEC_SPLIT`/`LOT` degrade the corresponding feature with a preview notice, never a crash |
| 6 | Backend crash-looped on migration `056_monte_carlo_scenarios.sql` ("trigger already exists") until the migration was hand-marked applied (gerardfarrell11 — **not** a .mny issue, but raised in the thread) | A partially-applied migration state plus non-idempotent `CREATE TRIGGER`; the runner `process.exit(1)`s with little diagnostic help | `056` in the current tree is already guarded with a `pg_trigger` existence check. **Done in Track B:** the full-corpus audit found no other unguarded DDL, and both gates now exist — a static lint (`npm run migration:lint`) plus a double-apply pass in `verify-schema.sh` (B1) — while `db-migrate.ts` prints the failing filename, SQLSTATE, every pg diagnostic, the offending line and a pointer to `docs/database-migrations.md` before its non-zero exit (B2) |
| 7 | Setup friction: manual `npm install pg`, missing `libatomic1`, `.env` password with `$T` mangled by shell interpolation (gerardfarrell11, kenlasko) | Inherent to the external-toolchain design | Disappears entirely with the native in-app import. The Money file password is a form field, never a shell variable |

### PoC design flaws to not repeat (from code review of `migrate.ts`)

- **Deletes all user data unconditionally** before importing (budgets, transactions, accounts,
  payees, categories). In this design the importer never deletes; the wizard offers an optional
  "start fresh" that calls the existing selective `UsersService.deleteData` primitive behind a
  typed confirmation (M3.3).
- **Hardcoded `NZD` fallback currency** (the author's locale). Base currency comes from the Money
  file's own defaults (`DHD` table, spike-confirmed field) with the user's `default_currency`
  preference as fallback.
- **Per-row awaited INSERTs** — 37k transactions and 68k prices, one round-trip each. Replaced by
  chunked multi-row inserts with pre-generated UUIDs (section 6, ADR-9).
- **`ON CONFLICT (user_id, symbol) DO UPDATE`** on securities collapses distinct funds sharing a
  symbol, and empty symbols became `name.slice(0, 20)` — colliding for similarly-named funds.
  Replaced by deterministic suffixing (`VOO-2`) plus a report warning; empty symbols get generated
  unique placeholders (matching the existing importer's placeholder convention).
- **Currency pseudo-securities imported as real securities** — Money stores currencies in `SEC`
  with `sct = 4`; these are excluded.
- **`'z '` name-prefix treated as a closed-account signal** — that is one user's personal naming
  convention, not a Money semantic. Only `fClosed` marks an account closed. Because
  `AccountsService.updateBalance` rejects closed accounts, closure is applied **after** the
  account's transactions are written.
- **Frequency mis-mapping**: Money bimonthly -> BIWEEKLY (wrong: every 2 months vs every 2 weeks)
  and semiannually -> YEARLY. Monize already had `SEMIMONTHLY`; Track B task B3 has since added
  `EVERY2MONTHS` and `SEMIANNUAL`, so every Money recurrence code now maps exactly and the
  downgrade-with-warning path is left only for intervals Monize cannot express.
- **No i18n, no tests, no wizard integration** — all mandatory here (sections 9–10).

## 4. The .mny format and the native parsing strategy

### 4.1 Format facts (verified against jackcess/jackcess-encrypt sources)

- A `.mny` file is a Jet 4 page-structured database. Version byte at offset `0x14` is `0x01`
  (same as Access 2000–2003); the engine-name string at offset `0x04` reads `MSISAM Database`
  instead of `Standard Jet DB`. Page/data layout is Jet 4; only the crypto differs.
- MSISAM files are **always encrypted**, even with no user password (a blank password feeds the
  same key derivation).
- Decryption (from jackcess-encrypt's `MSISAMCryptCodecHandler`, Apache-2.0 — algorithm ported,
  not code copied):
  - Password uppercased, encoded and zero-padded to `0x28` bytes; digested with SHA-1, or MD5
    when the flag bit `0x20` at header offset `0x298` is unset.
  - 8-byte salt at header offset `0x72`; base key = digest (16 bytes) + salt portion; per-page
    key = base key with the page number XORed into the trailing bytes.
  - Cipher is RC4 (trivial in pure TS; not in Node's OpenSSL 3 default provider, so implement
    the ~20-line stream cipher directly).
  - **Only pages 1..0xE are encrypted** ("new encryption", flag `0x6`); the rest of a 200 MB file
    is plaintext Jet 4. Older files use a Jet-style "old encryption" fallback (also RC4-based).
  - Password verification: decrypt 4 bytes near offset `0x2e9` and compare against the salt.
- npm **`mdb-reader` v3.2.0** (MIT, pure JS, actively maintained): parses Jet 3/4 + ACE, returns
  typed values (dates as Date objects, decimals/currency preserved), and already returns a
  dedicated MSISAM format from its detector — but its codec factory has no MSISAM branch, so
  MSISAM files fall through to a no-op codec and the first 14 pages read as ciphertext.

### 4.2 Strategy

**Plan A (primary):** implement `msisam-decrypt.ts` in the backend. It verifies the password,
RC4-decrypts pages 1..0xE of the buffer in place (~56 KB of cipher work regardless of file size),
and hands the now-plaintext buffer to stock `mdb-reader`, whose MSISAM identity-codec path is then
correct. No fork logic, no upstream dependency on our timeline.

**Plan B (fallback, and upstream candidate):** if Plan A trips over a file vintage (old-encryption
files, MD5-flag files), patch a real MSISAM codec handler into the vendored reader — the codec
interface is small and the fix is local. Either way, contribute the codec upstream to
`mdb-reader` as a stretch goal so the vendor copy can eventually be deleted.

**Vendoring:** ~~`mdb-reader` is ESM-only; the backend is CommonJS and Jest runs CJS. Rather than
fight `--experimental-vm-modules`, vendor the reader at
`backend/src/import/mny/vendor/mdb-reader/`.~~ Superseded during the Phase 0 spike: the reader is
a plain dependency, because `require(esm)` and the repo's existing Jest transform allowlist make
vendoring unnecessary. See section 6.1.

**Fixtures:** the jackcess-encrypt repository ships real sample files in `src/test/data/`:
`money2001.mny`, `money2001-pwd.mny`, `money2002.mny`, `money2008.mny`, `money2008-pwd.mny`
(Apache-2.0; the passwords are recorded in that project's tests). These become committed unit
fixtures with a provenance/license README (M0.1). Real-world acceptance uses the maintainer's
Money Plus Sunset file (56 accounts / 37k transactions / 98 securities / 68k prices) and the
Money 2001 file from the PR thread (72 accounts / 27.5k transactions) via the validation CLI
(M0.5) — those files never enter the repo.

## 5. Existing code this builds on (and its constraints)

Verified by exploration; file paths are current as of this writing.

- **Wizard**: `frontend/src/hooks/useImportWizard.ts` state machine; steps declared in
  `frontend/src/app/import/import-utils.ts` (`ImportStep`) and ordered in
  `frontend/src/app/import/page.tsx`; `UploadStep.tsx` has `accept=".qif,.ofx,.qfx,.csv"`.
  `detectFileType()` falls back to QIF for unknown extensions and the upload path calls
  `file.text()` — the `.mny` branch must be detected **before** any text read and use
  `ArrayBuffer`. `MultiAccountReviewStep.tsx` is the template for the review step;
  `CompleteStep.tsx` for results. The exact accept string is asserted in
  `UploadStep.test.tsx` and `e2e/tests/import.spec.ts` — both must change in the same PR.
- **Backend import module**: `backend/src/import/` — the multi-account QIF path
  (`ImportService.importQifMultiAccountFile`) is the orchestration model (one transaction,
  per-row SAVEPOINT, `ImportEntityCreatorService` for categories/accounts/investment pairs/
  loans/securities, regular + investment processors, `postImportProcessing` doing bulk balance
  recalc + price/FX backfill + net-worth recalc). The .mny writer reuses the entity creator and
  post-processing; it does **not** reuse the QIF heuristic transfer matching (section 6, ADR-8).
- **Transport precedents**: multipart via `FileInterceptor` + `memoryStorage`
  (`backend/src/attachments/attachments.controller.ts`); large raw bodies via a dedicated
  `express.raw` mount (`backend/src/backup/` restore path, 500 MB). Imports today are JSON
  string bodies capped at 10 MB — unusable for binary `.mny`.
- **No job infrastructure exists**: no queues, no job table, no generic SSE (only two hand-rolled
  AI streaming endpoints; the Next proxy passes `text/event-stream` through). Cron via
  `@nestjs/schedule` runs in-process — on Kubernetes, on every replica, so anything cron-adjacent
  must be idempotent/claimed.
- **RLS lint bans (hard CI gate)**: new DB code must use `withScopedDb(dataSource, (m) => ...)`
  (`backend/src/common/db/scoped-db.ts`). The counting ratchet this section originally described is
  gone -- it reached zero and was replaced by outright ESLint bans on `@InjectRepository`,
  `createQueryRunner()` and `dataSource.transaction()` in `src/` (`backend/eslint.config.mjs`). Code without an HTTP request context
  (the background job body, crons) wraps in `withUserContext(userId, fn)` /
  `withSystemContext(fn)`. Existing import helpers take a `queryRunner`-shaped object and only use
  `.manager` / `.query()` — the .mny writer passes a `{ manager, query }` shim backed by the
  `withScopedDb` EntityManager, reusing them with **zero** new ratchet sites. New tables need an RLS
  policy in the `user_id`-direct bucket plus a `database/schema.sql` mirror in the same PR.
- **Domain fit** (all existing, reused): transfers = two transaction rows cross-linked via
  `linked_transaction_id`; transfer splits (`transaction_splits.kind='transfer'`); status enum
  matches `cs`; investment cash+brokerage linked pairs match `hacctRel`; `investment_action` enum
  already has BUY/SELL/DIVIDEND/SPLIT/TRANSFER_IN/TRANSFER_OUT/REINVEST/ADD_SHARES/REMOVE_SHARES;
  `HoldingsService.rebuildAccountsFromTransactions(userId, accountIds, queryRunner)` is the
  canonical holdings rebuild; `CurrenciesService.ensureSystemCurrency(code)` creates currencies
  idempotently with proper metadata; `UsersService.deleteData` is the safe selective wipe;
  scheduled transactions support splits/transfers/investment templates and `is_active`.
- **Gaps to fill**: ~~no `EVERY2MONTHS`/`SEMIANNUAL` frequency~~ (added in B3, with the frontend's
  four hand-rolled steppers folded into `frontend/src/lib/frequency.ts`); categories are two-level
  (deeper Money trees flatten); `is_income` must be derived (spike); no background job table
  (M1.1).

## 6. Architecture decisions

**ADR-1 — Transport: multipart upload.** `POST /api/v1/import/mny/parse` uses
`FileInterceptor("file", { storage: memoryStorage(), limits: { fileSize } })` like attachments,
with `password` as an optional multipart text field. Limit from `MNY_IMPORT_LIMIT_MB` (default
300). No `main.ts` raw-mount changes; traverses the Next proxy (backup restore already proves
large bodies do). Frontend uses per-call axios timeouts (300 s for the upload+parse, 10 s polls).

**ADR-2 — Two-phase flow with server-side staging in the DB.** Parse/preview and import are
separate calls (the wizard's review step sits between). The **decrypted** buffer is staged in a
new `import_staged_files` bytea table (pattern: `attachment_blobs`), keyed by user with `sha256`,
`filename`, `size_bytes`, `expires_at`. Rationale: with more than one backend replica the import
call may land on a different pod than the upload; the database is the only shared store. Staging
post-decryption means the password is used once and never persisted. Import re-parses the staged
bytes (deterministic; no serialized intermediate representation to drift from the parser). Rows
are deleted on completion and swept by a TTL cron (24 h).

**ADR-3 — Asynchronous import job with polling.** `POST /import/mny/start` inserts an
`import_jobs` row (`status`, `options` jsonb, `staged_file_id`, `progress` jsonb, `result` jsonb,
`heartbeat_at`), claims it atomically (`UPDATE ... WHERE id = $1 AND status = 'pending'`), and
runs the import as an unawaited in-process task wrapped in `withUserContext`. The wizard polls
`GET /import/mny/jobs/:id` (~1.5 s). Progress updates are written in their own short `withScopedDb`
(writes inside the import transaction would be invisible to pollers). A job with a stale
heartbeat (> 5 min) is marked failed-retryable; the staged file survives, so retry is
one click (new job, same staged file). No queue library, no Redis, no new process.

Reaping is demand-driven, because a stale row is a *lockout*, not litter: the partial unique
index refuses the user's next start, and `discard` is restricted to `pending`, so a dead
`running` job cannot be cleared from the client at all. `reapStaleJobsForUser` therefore runs
inside the transaction of the two requests that care -- `create`, which the row is about to
refuse, and the poll's `findOne`, which would otherwise keep rendering a progress bar for a
worker that is gone. `hasActiveJob` negates the same shared condition, so the advisory 409 and
the authoritative one cannot disagree. `reapStaleJobs` stays on an hourly cron as the
cross-user backstop for a user who closed the tab and never asked again.

**ADR-4 — Parsing layers** (each its own file, spec-covered):
`msisam/msisam-decrypt.ts` -> `vendor/mdb-reader/` -> `msisam/open-mny.ts` (wrapper exposing
`getTableOrNull`, column-presence map) -> `tables/*.ts` (typed tolerant row readers) ->
`map/*.ts` (pure functions producing an `MnyImportModel` + warnings) -> `mny-import.service.ts`
(writer). Mappers never touch the DB; the writer never parses. Only the decrypt/reader layers
need binary fixtures — mapper and writer edge cases are plain-object unit tests, which keeps the
95/94/95/85 backend coverage gates reachable.

**ADR-5 — Options are a backend DTO**, echoed with server-computed defaults in the parse
response: `wipeExistingData` (default false), `referencedOnlyPayees` / `referencedOnlyCategories`
(default true), `importClosedAccounts` (default true), per-account `include` +
`currencyOverride`, per-bill selection, `importPrices` / `importExchangeRates` (default true).

**ADR-6 — Memory.** Peak ~2x file size (multer buffer + bytea write); decryption is in-place;
tables materialize one at a time; the preview payload is summaries only (never row data).
Document `MNY_IMPORT_LIMIT_MB` and pod-memory guidance in helm values. A 200 MB file fits a
1 GB pod.

**ADR-7 — Password handling.** Multipart field on `/parse` only; request-scoped; never logged,
never stored, excluded from validation-error echo. Distinct errors: `mnyPasswordRequired` vs
`mnyPasswordIncorrect`. Blank-password files decrypt without prompting.

**ADR-8 — Dedicated intermediate representation.** The .mny pipeline maps Money tables directly
to a domain `MnyImportModel`, not through the QIF `QifFullParseResult`. The QIF IR cannot carry
exact transfer links (`TRN_XFER`), investment transfer/add/remove semantics, bills, price and FX
history, closed/favourite flags, or per-account currencies — and the QIF processor's
name-and-amount transfer *matching* is exactly what a file with authoritative transfer pairs must
not fall back to (it is implicated in the loan-split bug). Lower-level services are reused
(entity creator, currencies, holdings rebuild, shared post-processing extracted from
`ImportService` so both pipelines call one implementation).

### 6.1 Phase 0 spike findings (M0.1–M0.3, implemented)

Two things in section 4 were wrong or unnecessary; both are settled by working code
(`backend/src/import/mny/msisam/`) rather than by argument.

**Plan A works, for every fixture, including the "old encryption" vintage.** All five jackcess
files decrypt and parse; `money2001*.mny` uses the Jet-style scheme (flags `0x1` at `0x298`,
`0x6` bit clear) and needed the fallback implemented up front, so Plan B was never reached.
Schemes observed: `money2001*` old, `money2002` new/MD5 (flags `0x5`), `money2008*` new/SHA-1
(flags `0x3d`).

**The header page is obfuscated, and the design's offsets are relative to the de-obfuscated
copy.** Jet XORs page-0 bytes `0x18..0x95` with a fixed 126-byte mask (jackcess
`JetFormat.BASE_HEADER_MASK`, applied in `PageChannel.readRootPage`). The salt at `0x72` sits
inside that window. Reading it straight from the file yields a plausible-looking key that
decrypts every page to garbage, with no error until `mdb-reader` reports a wrong page type — the
single most expensive wrong turn in this spike. `jet-header.ts` owns the de-masking; nothing else
touches raw page-0 bytes. Two facts follow from it: the crypt-check offset is
`0x2e9 + demasked[0x72]`, and the "salt" is simply the Jet creation-date field reused.

**A file with non-blank crypt-check bytes is not necessarily password protected.**
`money2008.mny` has check bytes yet verifies against the blank password. So `passwordProtected`
is defined as "the blank password fails", which is what makes `mnyPasswordRequired` and
`mnyPasswordIncorrect` distinguishable (ADR-7) and lets an unprotected file open without a
prompt.

**`mdb-reader` is a plain dependency, not vendored.** The vendoring in M0.3 existed to avoid
ESM/CJS friction, and that friction does not exist here: TypeScript `nodenext` emits `require()`,
Node 22+/24 resolves `require(esm)` natively, and Jest already transforms ESM-only packages
through the `transformIgnorePatterns` allowlist the repo uses for `openid-client`, `jose` and
`uuid` — `mdb-reader` was added to it. Verified in both directions: the compiled `dist/` bundle
opens `money2008-pwd.mny` under plain `node`, and the specs run under Jest. This drops 69 files
of third-party source from `src/`, the coverage/lint exclusions they would need, and the drift
risk `VENDORING.md` was meant to manage. If a future `mdb-reader` release needs an MSISAM codec
patch, vendoring is still the escape hatch — `open-mny.ts` is the only file that imports it.

### 6.2 Table-reader findings (M0.4, implemented)

The readers live in `backend/src/import/mny/tables/`, driven by declarative specs
(`table-reader.ts`): each field names the Money column (or columns, newest-first) it comes from
plus a converter. A table this Money version lacks reads as zero rows; a column it lacks reads as
the converter's default, and both are reported in a `TableAvailability` record rather than
thrown. `readMnyTables(db)` returns the whole bundle and is the last layer that knows about Jet.

Four things the fixtures settled, each now pinned by a test:

- **Money Plus renamed `TRN.hpay` to `TRN.lHpay`.** A file has exactly one of the two. Reading
  only `hpay` — as the design's section 8.2 implies — silently drops *every payee* on a Money
  2001/2002 file, and reading only `lHpay` drops them on a Money Plus file. This is the column
  alias the reader layer exists for.
- **`SEC_SPLIT` carries no security handle.** The link runs `SEC_SPLIT.hss` <- `SP.hss` and then
  `SP.hsec`, so `readInvestmentData` returns a `splitSecurities` map built from the price rows.
  Task M2.2 must use it rather than looking for an `hsec` column that does not exist.
- **`DHD.hcrncDef` is the file's base currency** — open question 12.1, answered: GBP in
  `money2002.mny`, USD in `money2008.mny`. `hcrncCur` is null in every sample.
- **Money's "no date" sentinel is year 10000** (`+010000-02-28`), not a two-digit-year pivot.
  1320 of the 2292 date values in `money2002.mny` are it. `mdb-reader` decodes Jet datetimes
  natively from an absolute epoch value, so the PoC's MM/DD/YY 70-year pivot is indeed obsolete
  (open question 12.5, answered); dates outside 1900–2199 normalise to null, which also covers
  the Jet zero date 1899-12-30.

Partial answer to **open question 12.2** (`CAT` income/expense signal): every category tree
descends from one of two roots, `INCOME` (`hcat` 130) and `EXPENSE` (`hcat` 131), which are the
only rows with `nLevel` 0 and a null `hcatParent`. Root-ancestor classification therefore works.
(A first reading of this data called `lType` unusable because income categories carry both 2 and
3; a cross-tab against the roots in M0.6 showed it is in fact clean — see 6.3.)

Column-presence differences across the fixtures are pinned as a table in
`read-mny-tables.spec.ts`: Money 2001 lacks `CRNC.fHidden` and `TRN.hbillHead` (and the whole
`BILL` table), Money 2002 lacks `CRNC.fHidden`, Money Plus has everything. Growing that list has
to be a deliberate edit rather than silent data loss.

### 6.3 Spike report (M0.6, implemented)

Money's coded values and their Monize equivalents live in
`backend/src/import/mny/model/mny-model.ts`. Every constant is labelled **confirmed** (asserted
against the committed fixtures in `mny-model.spec.ts`) or **unconfirmed** (carried from PR #192's
format reference). Mappers own row-level rules; this file owns only code-to-meaning lookups over a
single value, so an unconfirmed code surfaces as a warning rather than a silent mapping.

**`CAT.lType` is a clean income/expense flag** — this corrects 6.2. Cross-tabbing `lType` against
each category's root ancestor across all three vintages gives no crossover in 349 categories:
`-1` marks the two roots, `{0, 1}` sit under `EXPENSE`, `{2, 3}` under `INCOME`. So
`isIncomeCategoryType` reads `lType` directly and returns null only for the roots, where the
caller walks to the root ancestor. Open question 12.2 is answered, with the ancestor walk as the
fallback rather than the primary signal.

**`SEC.sct` codes are not stable across releases**, which weakens the design's "exclude `sct = 4`"
rule for currency pseudo-securities. The same Amex index securities are `sct` 6 in Money
2001/2002 while the Money Plus indices are `sct` 7, and `sct` 3 is a unit trust. No fixture
contains a currency pseudo-security at all, so `sct = 4` is unverified. The version-independent
second signal is the symbol: every `CRNC.szSymbol` in every fixture has the shape `/GBPUS` —
slash, three-letter currency, two-letter quote currency — so `isCurrencyPseudoSecurity` tests the
code **or** the symbol shape. M2.1 should use it rather than the code alone.

**Frequency mapping is code plus interval.** `cFrqInst` is Money's interval multiplier, and
several combinations land exactly on a Monize type that the code alone does not reach: weekly × 2
is BIWEEKLY, weekly × 4 is EVERY4WEEKS (likewise monthly × 2 → EVERY2MONTHS, × 3 → QUARTERLY,
× 6 → SEMIANNUAL, × 12 → YEARLY). Where no exact type exists, `mapFrequency` falls to the next
**shorter** period and returns `approximate: true`. Shorter is the safer error while v1 imports
bills with `auto_post = false`: an extra reminder is noise, a missed one is a missed payment.
PR #192 erred in both directions (bimonthly → BIWEEKLY, semiannual → YEARLY). Track B task B3
has since added `EVERY2MONTHS` and `SEMIANNUAL`, so an unrepresentable interval (weekly × 3,
monthly × 5, yearly × 2) is all that still approximates.

**But the code table itself was a guess, and issue #1150 caught it.** A Money Plus Sunset file's
yearly bills imported recurring every two months — `frq` 5 under PR #192's table — while its
monthly bills were right, so 5 is yearly, 3 is monthly, and 4/6/7 are claims from a source now
known to be wrong. They map to nothing and are reported with their raw `frq`/`cFrqInst`. The
durable half of the fix is that `BILL` answers the question itself: it holds one row per
occurrence, so `inferFrequencyFromDueDates` reads the cadence off the spacing of a series'
instances and `map-bills.ts` prefers it to the code. A table nobody can check loses to the file
in front of us.

**Still unanswerable from the fixtures.** `BILL` is empty in all five files and the transactions
exercise only `act` 0, 1 and 15, so `BILL.st` (question 12.3) and the `act` 5 / 14 semantics
(12.4) need a real file. `mny-model.ts` deliberately exports **no** `BILL.st` constant — a
plausible-looking one would only make the guess harder to see — and lists 5 and 14 in
`MNY_UNCONFIRMED_ACTIONS` so mappers can warn per transaction. Account types beyond `at` 0 and 5 are likewise unconfirmed. The
`grftt` bits **are** now settled, but only because Phase 4 measured them on a real file: the
fixture rows carry 0x2 (Money 2001/2002) and 0x10 (Money Plus) and could never have shown that
0x80 is the debt-account bit rather than the void bit, or that void is 0x100.

`npm run mny:inspect -- file.mny --table BILL` against a real Money Plus file closes 12.3 and
12.4 in one pass.

**ADR-9 — Write performance.** Pre-generate UUIDs for all transactions/splits in the mapper so
transfer pairs and splits are wired before insert; insert in chunks of ~500 via
`manager.insert`; back-patch `linked_transaction_id` with a single
`UPDATE ... FROM (VALUES ...)` pass; compute per-account balances in memory, write once, then run
the shared bulk recalc as a cross-check. Prices and FX rates are multi-row upserts. Target: the
37k-transaction + 68k-price Sunset file in well under 3 minutes end-to-end.

### 6.4 Phase 1 findings (M1.1–M1.10, implemented)

Five things this plan specified turned out differently once code existed. Each is
settled by a test rather than by argument.

**Progress needed a new primitive, not a "short `withScopedDb`".** ADR-3 says
progress is written "in their own short `withScopedDb`", but a nested
`withScopedDb` *joins* the ambient transaction by design (that is what stops the
pool-exhaustion deadlock), so a write inside the import transaction stays
invisible until commit -- a frozen progress bar for the whole run. Phase 1 adds
`runOutsideActiveScopedManager` to `common/db/scoped-db.ts`: it hides the ambient
manager so the inner call opens its own transaction on its own connection. It is
documented as correct only for a small statement at a phase boundary; used per
row it would reproduce exactly the deadlock the nesting rule prevents. An
integration spec asserts a poller sees progress from inside an open transaction.

**The wipe cannot happen inside the job.** `UsersService.deleteData`
re-authenticates, so running it in the job body would mean writing the user's
password into `import_jobs.options`. It runs in `start()` instead: a failed
re-authentication fails the request, and the credentials are spent on that one
call.

It runs *after* the job row is inserted, though, not before. The row is the
user's import lock -- `import_jobs` carries a partial unique index on `user_id`
where the status is `pending` or `running` (migration 135), so the second of two
concurrent starts blocks on the first and then fails, and `create` turns that
into the 409 the wizard already renders. A destructive operation performed
*before* the lock is held is one both racing requests can perform. A wipe that
fails takes the row back out with it (`jobs.discard`), so the refused request
does not leave the user holding a slot for a job that will never run.

**Categories do not route through the QIF entity creator.** ADR-8 hoped to reuse
`ImportEntityCreatorService` behind a `{manager, query}` shim. Its
`createCategories` hardcodes `isIncome: false`, which would discard the income
flag the mapper derives from `CAT.lType`, so Phase 1 has dedicated writers. The
reuse that *did* land is the one that matters: `postImportProcessing` is extracted
into `ImportPostProcessingService` and called by both pipelines, so the balance
query the verification report reconciles against has exactly one definition.

**Mutually-referential links need a patch pass, and pre-generated ids do not
avoid it.** ADR-9's pre-generated UUIDs let the mapper wire transfer pairs before
insert, but both `transactions.linked_transaction_id` and
`accounts.linked_account_id` are self-referencing foreign keys pointing *both*
ways, so no insertion order satisfies them inline. Both go in as one
`UPDATE ... FROM (VALUES ...)` pass after the rows exist -- which is also what
`AccountsService.createInvestmentPair` does. The integration spec caught the
accounts half; without a real database the inline version looks correct.

**"Orphaned transfer side" had to be narrowed.** Section 8.2 excludes orphaned
sides, but the phrase covers two very different cases. Phase 1 drops only a
dangling `TRN_XFER` reference to a row that is not in the file. A counterpart
that exists in an account the user chose *not* to import keeps its row as a plain
transaction with a warning: dropping it would silently remove real money from an
account the user did import, which is the exact class of discrepancy the
verification report exists to surface.

**The upload limit had to exist in code, not only in interceptor config.** The
size ceiling was multer configuration (`limits.fileSize`), which no static
analyser can see -- so CodeQL reported the RC4 page loop as iterating a
user-controlled buffer of unbounded length. `parse()` now re-asserts
`MNY_IMPORT_LIMIT_BYTES` against the buffer it was actually handed, sharing the
one localized "too large" error with the interceptor. Bearer's three
observable-timing findings on the wizard's `mnyPasswordRequired` /
`mnyPasswordIncorrect` comparison are false positives (the compared value is an
error code, not a password) and carry dated exceptions in `ci.yml`.

Two further notes for later phases. Investment rows are identified by carrying a
security, not by `act`: `act = 0` is BUY and cannot be told apart from a plain
payment by action code, and every transaction in all five fixtures is an
investment row -- so the banking mapper defers them by count and Phase 2 reads
them from the same tables. And the committed fixtures contain **no banking
transactions at all**, so the transfer, split and loan-payment cases are driven
from plain-object row builders (`__fixtures__/mny-row-builders.ts`) through the
real mappers and, in the integration spec, the real INSERT path.

## 7. Wizard UX

1. **Upload** (existing step): accept gains `.mny`; the file is read as `ArrayBuffer`. If parse
   returns `mnyPasswordRequired`, an inline password prompt appears and the upload retries with
   the password field. Money 97/98 (Jet 3) files get the explicit unsupported-version message.
2. **Review** (new `mnyReview` step, modelled on `MultiAccountReviewStep`):
   - File summary: detected Money era, base currency, table availability notes ("No
     scheduled-bills table — Money 2001 format").
   - Account table with include checkboxes: name, mapped type, currency (overridable), transaction
     count, opening balance, **final balance computed from the file**, closed/favourite badges.
     Closed accounts included by default, badge shown.
   - Counts row: payees (referenced/total), categories (referenced/total), securities (real, with
     pseudo-currency exclusions noted), prices, FX rates, bills ("21 active of 1,844 rows").
   - Options panel (ADR-5) including the wipe-first checkbox with a typed-confirmation dialog
     that names the existing delete-my-data operation it invokes.
   - Bills panel (when `BILL` exists): checkbox list of detected-active bills (payee, amount,
     frequency, next due), active candidates pre-checked.
   - Mapper warnings surfaced inline (symbol collisions, unknown act codes, frequency
     downgrades, LOT mismatches).
3. **Import** (new `mnyImporting` step): polls the job; phase progress (Preparing, Accounts &
   reference data, Transactions n/total, Investments, Bills, Prices & rates, Finalizing,
   Verifying). Failure shows the localized error with Retry (reuses staged file) / Start over.
4. **Complete** (extended): existing result counts plus the **verification report**: per account,
   expected final balance (recomputed from file data by the parser) vs imported balance vs delta
   with pass/warn state; per brokerage account, per-security share counts from transaction replay
   vs LOT-derived open lots; downloadable JSON. Banner: "All 56 accounts match" or "3 accounts
   differ — details below".

## 8. Data-mapping specification

### 8.1 Reference data

| Money source | Monize target | Rules |
|---|---|---|
| `DHD` (file defaults) | base currency context | Spike-confirmed field for the file's default currency handle; fallback = user's `default_currency` preference. Never a hardcoded literal |
| `CRNC` | `currencies` via `ensureSystemCurrency` | Only currencies actually referenced by imported accounts/securities/rates |
| `CRNC_EXCHG` | `exchange_rates` | Additive upsert on `(from, to, rate_date)`; toggle-controlled |
| `PAY` | `payees` | Referenced-only (default), degenerate-name filter, existing-payee find-or-create by name |
| `CAT` | `categories` | Parents before children (`nLevel`); flatten deeper than two levels into `Parent:Child` names; `is_income` derived per spike (root-ancestor classification, transaction-sign heuristic as fallback); referenced-only default |
| `SEC` (`sct != 4`) | `securities` | Per-user unique symbol; collision suffixing (`VOO-2`) + warning; empty symbols get unique placeholders with `skip_price_updates`; currency via `CRNC` map |
| `SP` | `security_prices` | Dedupe `(hsec, dt)` keep-latest; batch upsert; `source` marks the import |
| `ACCT` | `accounts` | `at` map: 0 bank -> CHEQUING, 1 -> CREDIT_CARD, 2 -> CASH, 3 -> ASSET, 4 -> LOAN, 5 -> INVESTMENT (paired), 6 -> MORTGAGE. `amtOpen` -> opening balance; `fFavorite` -> favourite; `hacctRel` on `at=5` -> linked cash/brokerage pair (reusing the entity creator's pair logic); `fClosed` -> closed **after** transactions are written |

### 8.2 Transactions

- Include a `TRN` row when: it has an account, a valid date, is not a split child, not a bill
  template (`BILL.lHtrn`), not part of a loan-payment template (`grftt & 0x4000`), not an
  orphaned transfer side, and `frq == -1`.
  **Scheduler-posted rows are imported** — they are real postings (loan payments,
  online-banking imports); excluding them was PR bug #1.
- **A transfer whose far side carries `hsec` is a transfer into the brokerage's cash sleeve.**
  Money's investment row is both the arriving cash and the trade, and the investment mapper
  spends that cash on the trade — so the import synthesizes the sleeve-side row Money has no
  place for. Without it 3,255 of the maintainer's transfers debited a bank account with nothing
  arriving anywhere, and the sleeves absorbed $553,225.57.
- **Loan-payment templates (`grftt & 0x4000`) are phantoms, whole families of them.** One per
  debt account: an account-less split parent, its legs, and the legs' counterparts *in the loan
  account*, which have a real account and date and so import as ordinary principal postings if
  only the parent is skipped. `BILL.lHtrn` does not reference them.
- **`grftt & 0x60000` is a scheduled instance Money never posted**, and is skipped like the
  loan-payment family. 67 rows, none reconciled in a file that is 74% reconciled, all inside
  2003-10-15..2004-09-28, every one also carrying `0x200000`. Importing them left four accounts
  out by exactly their total: CIBC Chequing $7,671.79 against Money's $0.00, CIBC VISA -$156.55
  against $0.00, the Standard Life sleeve $91.00 and Mortgage - 33 Spring $350.00, plus two of
  the three holdings mismatches. `ACCT.amtEndRec` agreed but could not prove it -- these rows are
  unreconciled, so a reconciled balance excludes them under either reading -- and the maintainer
  confirmed the rows are absent from Money's register.
- **`BILL.lHtrn` is not the template.** It points at whatever transaction the series currently
  holds, which for an entered bill is the posting: 1,843 of the maintainer's 1,845 are `frq != -1`
  and excluded anyway, and the other two were real 2003 postings worth $6,243.96. The row's own
  `frq` decides.
- **`TRN.szId` packs a kind digit in front of the reference** -- `1` then free text (`1Debit`),
  `0` then a number right-aligned in twelve characters (`0           2`). Imported whole it shows
  as `1Debit` and `0 2`. The number is Money's payment number inside a debt account (its loan
  register shows it as **Pmt Num**) and a cheque number everywhere else; both are references the
  user reads, so both are kept. Dropping the debt-account one left Ref. num. blank on every loan
  and mortgage row until issue #1174.
- `grftt & 0x100` -> status VOID (imported, excluded from balances by existing logic). **Not**
  `0x80`, which marks a row in a loan or mortgage account: using it voided every loan payment
  and left each debt account frozen at its opening balance.
- `cs`: 0 -> UNRECONCILED, 1 -> CLEARED, 2 -> RECONCILED. `dt` -> `transaction_date`
  (`YYYY-MM-DD` string per repo DATE convention; mdb-reader decodes Jet datetimes natively, which
  should obsolete the PoC's MM/DD/YY 70-year-pivot parsing — spike confirms; day-00 null
  sentinel handling stays). `szId` -> `reference_number`, `mMemo` -> `description`,
  `lHpay` -> payee, `hcat` -> category, `amt` -> amount (account currency).
- Splits: for each `TRN_SPLIT` child, category/amount/memo come from the child `TRN` row. A child
  that appears in `TRN_XFER` becomes a **transfer split** wired to the counterpart transaction's
  pre-generated UUID; the counterpart imports once as the loan/destination-side row.
- Transfers: `TRN_XFER` pairs -> both rows `is_transfer = true` and cross-linked
  `linked_transaction_id` (exact IDs — no name/amount matching). Cross-currency pairs keep each
  side's own amount.

### 8.3 Bills

`BILL` + template `TRN` (`lHtrn`) -> `scheduled_transactions` with splits/transfer/investment
template support. Active-series detection: `st` in the spike-confirmed active set, next-due date
within a sanity horizon, deduped per series. Wizard selection is authoritative; selected bills
import with `is_active = true`, `auto_post = false`. Cadence comes from the series' own instance
dates where they are regular enough to read (`map/bill-cadence.ts`), and from `frq` otherwise:
0 ONCE, 1 DAILY, 2 WEEKLY, 3 MONTHLY, 5 YEARLY, with 4/6/7 unknown since issue #1150 refuted the
reference above 3; `cFrqInst` interval honored where representable, else downgrade + warning.

### 8.4 Investments

Action mapping is driven from `TRN.act` (never from quantity sign; `TRN_INV.qty` is always
positive):

| act | Monize action | Notes |
|---|---|---|
| 0 | BUY | |
| 1 | SELL | |
| 3, 5 | REINVEST | act=5 variant noted in description; spike confirms distinction |
| 4 | DIVIDEND | **No `TRN_INV` row exists** — sourced from `TRN` directly, amount = `amt`, no quantity. The PoC iterated `TRN_INV` and dropped every one of these |
| 14 | CAPITAL_GAIN + warning | Rare cash corporate actions; spike refines |
| 15 | ADD_SHARES (cost basis from `amt`/`dPrice`) | Opens lots |
| 16 | REMOVE_SHARES — never SELL | Closes lots despite the name |
| 15+16 pair | TRANSFER_IN / TRANSFER_OUT | Paired across accounts by date + security + quantity; cross-linked via `linked_transaction_id`; unpaired rows stay ADD/REMOVE_SHARES |

`SEC_SPLIT` produces **no** transaction: Money does not apply those ratios to its own share
counts, and applying them makes the import disagree with the file (see the note below).
Cash legs use `TRN.amt` in the account currency. Holdings come only from
`HoldingsService.rebuildAccountsFromTransactions` after the write; the mapper's independent
LOT-derived open-lot positions (`htrnSell` empty, sum `qty`) and its action-replay positions are
compared and any disagreement becomes a verification-report warning. Foreign-currency cost basis
differences (Money stores base-currency values at historical rates) surface as warnings —
documented v1 limitation.

**Only securities the file shows activity for are imported.** `SEC` doubles as Money's watch list
and its index-quote store, and `sct` does not separate those from real holdings — the maintainer's
file keeps the Dow, the NASDAQ, the DAX, the FTSE, the Hang Seng, the Nikkei, the TSX and the
Straits Times under the same code as two ETFs actually owned. Activity does separate them: a
security referenced by no `TRN` row and no `LOT` is dropped, and its quote history goes with it
(31 of 98 securities, 17,025 of 69,076 prices).

**`SEC.sct` 4 is a money-market fund, not a currency.** The currency-pseudo-security test
excluded that code on the format reference's word; the four rows it hides in the maintainer's
file are TD Canadian Money Market, CIBC Canadian Money Market, CIBC Canadian T-Bill and McLean
Budden Money Market, and Money Plus's own `sample.mny` files four more under it. In a brokerage
account that fund *is* the sweep, so skipping the security took its cash movements with it: 829
of 4,524 investment transactions dropped, and five cash sleeves ended thousands of dollars out
(+11,571.95, -11,957.78, -941.58, -43.42, -11.17). Importing it lands every one of them within
two cents of zero. A currency is now recognised by the `/GBPUS` symbol shape alone, which is
where currencies actually live (`CRNC`); no `sct` code is read for meaning anywhere.

**`act` 12 is a credit of units, not a purchase.** It opens lots with a value and a quantity, so
it read as a buy — and charging the cash sleeve for it left the maintainer's Standard Life RRSP
$18,457.22 overdrawn where Money's own cash rows for that account net to $91.00, one unspent
contribution. The signal is `TRN_XFER`: `act` 1 has a cash counterpart 2,015 times in 2,029 and
`act` 3 has one 1,090 times in 1,090, while `act` 12 has one **zero** times in 92, exactly like
the `act` 9 reinvestments. 82 of the 92 sit in the one RRSP whose `ACCT` row sets `fEmpMatch`.
Mapped to REINVEST — a value and a position, no cash leg — the sleeve lands on Money's $91.00.
It stays in `MNY_UNCONFIRMED_ACTIONS`: the effect is measured, and issue #1149 later supplied the
name (Money's "Add Shares" activity), but Monize's REINVEST mapping remains a translation — chosen
so the stated value survives as cost basis — so the rows stay visible in the verification report.

**`SEC_SPLIT` ratios are not applied to positions, because Money does not apply them either.**
Seven positions across two files prove it: the maintainer's brokerage bought 200 VTI before a 1:2
split row and 100 after, then transferred the whole account away in a single 300-share row, and
`LOT` shows both purchases fully consumed — applying the ratio leaves 200 shares in an account
Money shows as empty, and XIU (1:4), XIC (1:4) and VWO (1:2) do the same. `sample.mny` agrees at
MSFT (`LOT` 3 against 6 replayed), LEH (50 against 1,225) and ADM (110.25 against 115.7625).
The rows are quote-feed metadata: the split's `SP` row is a `dPrice = 0`, `src = 0` marker with
continuous prices either side, they exist for securities the user never held, and Canadian ETFs
record a 1:1 one every December against a reinvested distribution. Ratios other than 1 raise
`securitySplitNotApplied` so the user can check the share counts; nothing is adjusted.

## 9. Task list

> Sized for one agent session/PR each (S < half day, M = half–2 days, L = 2–5 days). Do tasks in
> dependency order. Definition of done for every task: `npm run build && npm run lint` clean in
> the touched workspace; unit tests green at the coverage gates; any migration mirrored into
> `database/schema.sql` in the same PR; RLS ratchet counts not increased; user-facing strings
> through i18n **English-first** (`en` catalogs + `npm run i18n:pseudo`; the full 23-locale pass
> is the single M4.3 task, per the project's i18n workflow); no emojis; immutability rules.
> Money-file knowledge lives in `ms-money-data-model.md` (adopted in M4.5) — read it before any
> mapper task.

### Phase 0 — Spike, fixtures, foundations

Exit gate: all five jackcess fixtures parse end-to-end via the CLI; go/no-go on Plan A recorded.

| ID | Task | Depends | Size | Status |
|----|------|---------|------|--------|
| M0.1 | Commit jackcess-encrypt sample fixtures (`money2001.mny`, `money2001-pwd.mny`, `money2002.mny`, `money2008.mny`, `money2008-pwd.mny`) under `backend/src/import/mny/__fixtures__/` with provenance/license README (Apache-2.0) and documented passwords | — | S | **done** |
| M0.2 | `msisam/msisam-decrypt.ts`: RC4, key derivation (SHA-1/MD5 flag at `0x298`), salt at `0x72`, page loop 1..0xE, page-number key XOR, old-encryption fallback, password verify near `0x2e9`. Spec: all five fixtures decrypt; wrong password -> typed error; blank-password files open without a password | M0.1 | M | **done** |
| M0.3 | `msisam/open-mny.ts` wrapper over `mdb-reader` v3.2.0 (`getTableOrNull`, column-presence map, engine sanity checks); confirm the identity-codec path reads pre-decrypted buffers. Spec: table lists + row counts correct for all fixtures | M0.2 | M | **done** (not vendored — see 6.1) |
| M0.4 | Tolerant table readers (`tables/read-reference.ts`, `read-transactions.ts`, `read-investments.ts`, `read-bills.ts`) + typed raw-row model (`model/mny-rows.ts`) + date/amount normalization utils; build the per-version column-presence matrix across fixtures and encode defaults. Spec: every table reads or degrades gracefully on all fixtures | M0.3 | L | **done** (see 6.2) |
| M0.5 | Validation-harness CLI: `npm run mny:validate -- file.mny [--password ...]` prints accounts, transaction counts, per-account computed final balances, per-security holdings (replay + LOT), warnings. Acceptance: maintainer runs it on the real Sunset and Money 2001 files; output sane; runtime + memory recorded in the PR | M0.4 | M | shipped as `npm run mny:inspect`, now including the mapped view Phase 1 made possible: per-account transaction counts, file-computed final balances and grouped warnings, alongside the reader's scheme/table/column report. Holdings still need the investment mappers (M2.3) |
| M0.6 | Spike report resolving open questions (section 12): DHD base-currency field, CAT `is_income` signal, BILL `st` active semantics (validated against the known "~20 real bills" ground truth), act 5 vs 3 and act 14 semantics, native date decoding vs pivot logic. Constants land in `model/mny-model.ts` with the findings documented | M0.5 | M | **done** (see 6.3). Questions 12.3 and 12.4 need a real file — no fixture has a `BILL` row or an `act` outside {0, 1, 15} |

### Track B — Parallel, not .mny-specific

| ID | Task | Depends | Size | Status |
|----|------|---------|------|--------|
| B1 | Migration idempotency audit: guard all unguarded `CREATE TRIGGER` / `CREATE POLICY` / `CREATE INDEX` / `ADD COLUMN` / enum-value DDL across `database/migrations/*.sql` (mirroring the existing `056` pg_trigger guard); add a CI lint script that flags unguarded DDL in new migrations. Acceptance: re-running any migration body against an up-to-date DB is a no-op | — | M | **done** (see B1 below) |
| B2 | `backend/src/db-migrate.ts` failure UX: log failing filename, SQL error detail/position, and a runbook pointer before the non-zero exit (fail-fast retained); unit specs; short runbook section for the "partially applied" recovery that PR #192's thread walked through by hand | — | S | **done** |
| B3 | Frequency extension `EVERY2MONTHS` + `SEMIANNUAL`: `FrequencyType`, next-due-date calculator, scheduled-transaction UI selector, English catalogs + pseudo-locale. Acceptance: next-occurrence math specs for both | — | M | **done** (see B3 below) |

#### B1 findings — the corpus was already idempotent; the gates are new

The audit found **no unguarded DDL** to fix across the 102 migration files: every
`CREATE TABLE`/`INDEX` and `ADD COLUMN` carries `IF NOT EXISTS`, the four
`CREATE TRIGGER` sites use either the `056` `pg_trigger` `DO` block or a
preceding `DROP TRIGGER IF EXISTS` (`077`), every `ADD CONSTRAINT` is preceded by
its `DROP CONSTRAINT IF EXISTS` or wrapped in a `pg_constraint` check, the RLS
`CREATE POLICY` statements drop-then-create (including inside `112`'s `format()`
loop), and the one data `INSERT` (`018`) has `ON CONFLICT DO NOTHING`. Verified
empirically: `schema.sql` plus all 102 migrations applied **twice** against a
Postgres 16 instance, zero errors.

What was missing was enforcement, so B1 shipped the two gates instead:

- `backend/scripts/migration-lint.mjs` (+ `migration-lint.test.mjs` self-test,
  `npm run migration:lint`, wired into the "Backend Lint & Type Check" job) — a
  SQL-aware static lint. It splits each file into statements (dollar-quoted
  bodies handled, comments blanked offset-preserving), then checks each against a
  rule per DDL family: `IF [NOT] EXISTS` where the clause exists, a preceding
  `DROP ... IF EXISTS` of the same name for constraints/triggers/policies, an
  enclosing catalog-checking `DO` block otherwise, `OR REPLACE` for
  functions/views, `ON CONFLICT` for `INSERT`. Escape hatch:
  `-- migration-lint-disable-next-line <rule>: <reason>`, reason mandatory.
- `scripts/verify-schema.sh` now applies every migration on top of `schema.sql`
  **twice** ("Schema vs Migrations Drift" job). Pass 1 was already the
  no-op-on-current-schema proof; pass 2 covers the half-applied re-run that
  actually bites in production.

Runbook and guard recipes: `docs/database-migrations.md` (also the pointer B2's
failure report prints), summarised in `database/CLAUDE.md`.

#### B3 notes — one stepper, not five

The two types landed end-to-end: `FrequencyType` (backend enum, entity union,
frontend `FREQUENCY_VALUES` tuple that the form's `z.enum` now derives from),
`calculateNextDueDate` (`+2` / `+6` months, clamped), all 23 locales, migration
`116` (documentation no-op like `041`, `VARCHAR(20)` already fits), and
`mapFrequency` in `mny-model.ts` — Money's `frq` 5 and 7 and `cFrqInst` 2 and 6
now map **exactly**, so `approximate: true` is left only for intervals Monize
still cannot express (weekly every 3 weeks, monthly every 5 months). Section 3's
frequency bullet and 6.3's approximation note are resolved by this.

The frontend had **four** hand-rolled `switch (frequency)` steppers (cash-flow
forecast, occurrence picker, bills calendar, upcoming-bills report). Two had
already drifted — neither handled `SEMIMONTHLY`, so those schedules projected the
same date until the loop cap — and the forecast's `setMonth` overflowed Jan 31 to
Mar 3 where the backend clamps to Feb 28. All four now call
`frontend/src/lib/frequency.ts` (`advanceByFrequency`, `isOneTime`,
`monthlyEquivalent`), with `frequency.guard.test.ts` failing if a local switch
reappears. Phase 3's M3.1 can therefore drop the downgrade-and-warn fallback.

### Phase 1 — Core banking import, end-to-end behind the wizard (shippable)

Exit gate: cleared. A `.mny` file goes through the wizard end to end -- upload,
review, background import, per-account verification -- and the localization pass
that section 9 defers to M4.3 was done with it, so Phase 1 is fully translated.
See 6.4 for what the implementation settled differently from this plan.

| ID | Task | Depends | Size | Status |
|----|------|---------|------|--------|
| M1.1 | Entities + migration + RLS: `import_staged_files` (bytea, user-owned, `expires_at`), `import_jobs` (`status`, `options`, `progress`, `result`, `heartbeat_at`); `user_id`-direct RLS policies; `database/schema.sql` mirrored. Acceptance: cross-user isolation spec; ratchet unchanged | — | M | **done** |
| M1.2 | Staging service (`withScopedDb`) + TTL sweep cron + delete-on-complete; `docs/cron-jobs.md` entry. Acceptance: expiry works; sweep idempotent across replicas | M1.1 | S | **done** |
| M1.3 | Reference mapper (`map/map-reference.ts`): currencies (DHD base + `ensureSystemCurrency`), accounts (type/subtype map, `hacctRel` pairs, deferred closure, favourites, opening balances), categories (flatten, `is_income`, referenced-only), payees (junk filter, referenced-only), warnings model. Unit fixtures cover every `at` value, deep category trees, junk payees | M0.4, M0.6 | L | **done** |
| M1.4 | Transaction + transfer mapper (`map/map-transactions.ts`, `map/map-transfers.ts`): inclusion rule (`frq != -1` only — auto-entered rows import), statuses/void, splits, `TRN_XFER` pairing with pre-generated UUIDs, **loan-payment transfer splits**, reference numbers. Acceptance: loan fixture yields a transfer split linked to the loan-side transaction, each side imported exactly once | M1.3 | L | **done** |
| M1.5 | Parser service + preview builder (`mny-parser.service.ts`): orchestrates decrypt -> read -> map; computes per-account final balances (the verification baseline). Acceptance: preview for `money2008.mny` matches hand-computed values | M1.3, M1.4 | M | **done** |
| M1.6 | Controller + DTOs: `POST /import/mny/parse` (multer memoryStorage, `password` field, `MNY_IMPORT_LIMIT_MB`, i18n error taxonomy incl. required-vs-incorrect password and Jet 3 rejection), `POST /import/mny/start`, `GET /import/mny/jobs/:id`, `DELETE /import/mny/staged/:id`. Acceptance: contract specs; password never logged or echoed; oversized file -> clean localized error | M1.1, M1.5 | M | **done** |
| M1.7 | Job service: atomic claim, heartbeat, progress writer in its own `withScopedDb`, stale reaper cron, retry semantics (staged file survives failure). Acceptance: simulated double-claim has a single winner; stale running job reaped to failed-retryable | M1.1 | M | **done** |
| M1.8 | Writer v1 (`mny-import.service.ts`, `writers/write-transactions.ts`): optional wipe via existing `UsersService.deleteData` (own transaction, before the job body), entity creation via the `{manager, query}` shim over `withScopedDb`, chunked inserts + `linked_transaction_id` back-patch, single balance write per account, deferred account closure, **shared `postImportProcessing` extracted** from `ImportService` and called by both pipelines, verification report v1 (balances). Acceptance: integration spec imports a fixture and balances match parser-computed values; QIF suite still green after the extraction; no new ratchet sites | M1.4–M1.7 | L | **done** |
| M1.9 | Frontend: `useMnyImport` hook (upload, options, start, polling, retry) composed into `useImportWizard`; `detectFileType` + ArrayBuffer path; `ImportStep` additions (`mnyReview`, `mnyImporting`) + `page.tsx` step order; `MnyReviewStep`, `MnyImportProgress`; `CompleteStep` verification table; accept-string updated **with** `UploadStep.test.tsx` and the e2e assertion; `lib/import-mny-api.ts` with per-call timeouts; English catalogs + pseudo-locale. Vitest to gates | M1.6 | L | **done** |
| M1.10 | Verification report UI: pass/warn rows, JSON download, trust-builder copy | M1.8, M1.9 | S | **done** |

### Phase 2 — Investments (shippable increment)

Exit gate: cleared. A `.mny` file's securities, investment transactions, stock
splits, price history and exchange rates go through the same wizard, and the
verification report gained a per-holding section reconciling what Monize holds
against Money's own open tax lots. `money2002.mny` imports end to end with all 30
positions matching and no negative holdings. The localization pass that section 9
defers to M4.3 was done with it, so Phase 2 is fully translated.

See 6.5 for what the implementation settled differently from this plan.

| ID | Task | Depends | Size | Status |
|----|------|---------|------|--------|
| M2.1 | Securities mapper: `sct=4` exclusion, symbol-collision suffixing, empty-symbol placeholders. Acceptance: collision fixture creates two securities + warning, never collapses | M1.3 | M | **done** (`map/map-securities.ts`; the exclusion tests the symbol shape as well as `sct`, per 6.3) |
| M2.2 | Investment mapper (`map/map-investments.ts`): full act map per section 8.4 (incl. act=4 dividends sourced from `TRN` without `TRN_INV`), act 15+16 transfer pairing, `SEC_SPLIT` -> SPLIT, positive-qty policy, cash legs. Unit fixtures per act code | M2.1, M0.6 | L | **done** |
| M2.3 | LOT cross-check: open-lot holdings vs action-replay holdings -> verification warnings (never import failures). Seeded-mismatch fixture produces a warning | M2.2 | M | **done** (`map/check-holdings.ts`; also surfaced by `npm run mny:inspect`) |
| M2.4 | Investment writer (`writers/write-investments.ts`): batched investment transactions + cash legs, `HoldingsService.rebuildAccountsFromTransactions` per affected brokerage account, holdings section in the report. Acceptance: fixture holdings equal LOT-derived positions; negative-holdings regression test covering the PR #192 failure mode | M2.2, M1.8 | L | **done** |
| M2.5 | Prices + FX writer: `SP` dedupe keep-latest, multi-row upserts to `security_prices` (import source marker) and `exchange_rates`; toggles honored. Acceptance: synthetic 68k-price set imports < 30 s in the integration environment | M2.1 | M | **done** for the writers and toggles; the 68k-row timing belongs with the M4.1 performance pass against the real Sunset file rather than to a synthetic set |
| M2.6 | Wizard: securities summary on review, holdings section in the verification report, investment progress phase | M2.4, M1.9 | M | **done** (also exposes the `importPrices` / `importExchangeRates` toggles ADR-5 defined but Phase 1 never surfaced) |

#### 6.5 Phase 2 findings

Five things this plan specified turned out differently once code existed.

**An investment's cash leg is one row, not a transfer pair.** The QIF processor
writes a cash transaction *and* a mirroring row in the brokerage account when the
two differ, which nets to zero across the pair. Copying that here would give the
brokerage side a `current_balance` the Money file never recorded -- Monize's
brokerage value comes from holdings -- and the verification report, which
compares per-account balances, would then disagree with itself on every
investment account. The `.mny` writer creates exactly one cash transaction, in
the cash sleeve, linked from the investment row through `transaction_id`.

**`computeExpectedBalances` had to learn about investment cash.** It folded
banking transactions only. Once buys and sells post into the sleeve, a sleeve's
expected balance that ignores them is wrong by the account's entire trading
history, and every brokerage cash account reports a discrepancy. The investment
legs now fold into the same integer-minor-unit accumulator.

**The currency list is not the accounts' currency list.** `exchange_rates` has a
foreign key to `currencies` on *both* sides, and a security can be denominated in
a currency no account uses, so `ensureSystemCurrency` has to run over the union
of account, security and rate currencies. Rate currencies are collected only when
that toggle is on, so unticking it does not create currencies for nothing.

**An unpaired `act` 15/16 row must not warn.** The first cut warned on every
ADD/REMOVE_SHARES row with no counterpart. `money2002.mny` alone produces 60 of
them, because shares transferred in from a broker is simply how a portfolio
starts. The position is identical whether or not the pairing is found -- only the
"this was a transfer" semantic is lost -- so 60 lines of noise buried the
warnings that mean something. The LOT cross-check is the real safety net.

**Magnitude comes from `TRN.amt`, direction from the action.** Money's own cash
figure already carries commission and any accrued interest, so recomputing
`qty * price + commission` disagrees with what Money shows by exactly those
amounts. The sign is discarded and taken from the action, which is the same rule
section 8.4 states for quantity.

Two things the plan got right and are worth recording as confirmed. The holdings
rebuild runs on the import transaction's own `EntityManager` through a
`{ manager }` shim: `rebuildAccountsFromTransactions` only ever touches
`queryRunner.manager`, and a second connection would deadlock against the open
transaction. And `SEC.sct` is deliberately **not** mapped onto Monize's
`securityType` -- 6.3 showed the codes shift between releases, so any mapping
mislabels some file; the column stays null for the user to set.

**First end-to-end evidence the act map is right.** `money2002.mny` carries 60
`act = 15` rows and 60 open `LOT` rows across 30 securities. The integration
suite imports it and asserts all 30 positions equal the LOT-derived ones, every
quantity positive -- the negative-holdings failure mode from PR #192 issue 4.
`npm run mny:inspect` prints the same reconciliation, which completes the M0.5
validation harness that 6.2 left open. The corpus still cannot exercise `act` 4,
5, 14 or 16, or `SEC_SPLIT`: those paths are covered by plain-object fixtures and
still want a real file (open questions 12.3 and 12.4 remain open).

### Phase 3 — Bills, loans polish, wipe UX (shippable increment)

Exit gate: cleared. Scheduled bills go through the wizard as a checkbox list,
the optional wipe is behind a typed confirmation, and loan accounts come out
configured rather than merely populated. The localization pass that section 9
defers to M4.3 was done with it, so Phase 3 is fully translated.

See 6.6 for what the implementation settled differently from this plan.

| ID | Task | Depends | Size | Status |
|----|------|---------|------|--------|
| M3.1 | Bills mapper (`map/map-bills.ts`): active-series detection (`st` + due-date horizon + series dedupe per M0.6), `lHtrn` template resolution (splits/transfer/investment templates), frequency map via `mapFrequency` (B3 landed: every code exact, downgrade + warn only for unrepresentable intervals). Acceptance: the kenlasko scenario yields ~20 active candidates from 1,844 rows; Money 2001 absence degrades with a notice | M0.6, M1.4 | L | **done** (detection is date-horizon + series dedupe only -- `st` is carried, never filtered on; see 6.6) |
| M3.2 | Bills writer + wizard selection panel (`MnyBillsPanel`): only selected bills imported, `is_active=true`, `auto_post=false`. Acceptance: unchecked bills are absent from the DB, not inactive | M3.1, M1.9 | M | **done** |
| M3.3 | Wipe-first UX: typed-confirmation dialog naming the delete-my-data operation, wiring to `deleteData` as a pre-step, report line "existing data removed". Default import never deletes | M1.8 | S | **done** |
| M3.4 | Loan verification on real files: loan/mortgage balances in the report, mortgage subtype mapping, escrow split refinement. Acceptance: maintainer's loan accounts reconcile in the harness | M1.4, M0.5 | M | **done** for what the corpus can prove: loan terms are inferred and written (`map/map-loans.ts`), loans are badged in the report and printed by the harness. The real-file reconciliation is the maintainer's acceptance run |

#### 6.6 Phase 3 findings

Five things this plan specified turned out differently once code existed.

**`BILL.st` is still unobserved, so nothing filters on it.** M3.1 was written
to use "`st` in the spike-confirmed active set", but M0.6 could not confirm one
-- `BILL` is empty in all five fixtures (open question 12.3) -- and a
plausible-looking constant would have been a guess wearing a filter's clothes.
Active-series detection is therefore **date and series shape only**: rows are
grouped by `hbillHead`, each series is reduced to the earliest instance still
due on or after the cut-off, and a series survives if that date sits within
`BILL_PAST_HORIZON_DAYS` (92) and `BILL_FUTURE_HORIZON_DAYS` (400) and its
`dtMax` has not passed. The raw `st` value rides along on every candidate and
`npm run mny:inspect` prints its distribution, so one run against a real file
both closes question 12.3 and says whether the horizon rule already produces
the "~20 of 1,844" ground truth on its own.

**The wizard's selection has to be distinguishable from its absence.** ADR-5
made `bills` an option list defaulting to empty, which cannot express "the user
unticked everything" -- empty would equally mean "the client said nothing".
The parser now resolves it: an absent `bills` field means every detected-active
candidate (the default the preview echoes), and an explicit list, empty
included, is the user's choice narrowed to real candidates. The wizard always
sends the field.

**Referenced-only filtering counts selected bills, not candidates.** Section 3
issue 3 says payees and categories are created when "referenced by an imported
transaction, split, or selected bill". Computing that from the candidates would
create a payee for a bill the user unticked, so `billReferences` runs over the
selection and the parser unions it into the referenced sets before mapping
categories and payees.

**A loan's interest category cannot be inferred when escrow is present, and
must not be.** M3.4's "escrow split refinement" turned out to be a refusal
rather than a heuristic. Interest and escrow are both ordinary category legs of
the payment split and nothing in the file distinguishes them, so `mapLoans`
adopts a category as the loan's interest category only when the payments name
exactly **one** non-principal category. Two or more leaves it null with a
`loanInterestCategoryUnclear` warning. Guessing would put escrow into
`interest_category_id`, and `RateChangeInferenceService` would then infer every
rate from the wrong leg.

**Loan payment shape is worth reading even though Money has no loan-terms
table.** What it does have is the payment: a transfer leg into the loan plus a
category leg for interest is exactly Monize's `SPLIT` interest booking mode,
the account the payment came from is the funding account, and an imported bill
supplies the scheduled installment and cadence. `writeLoans` fills those in
without ever overwriting a value the account already carries, so a second
import into a live profile cannot clobber a loan the user configured by hand.
`SPLIT` is claimed only when *every* observed payment was split-booked: a loan
that also receives plain transfers has its interest booked elsewhere, and
claiming SPLIT there would suppress the separate-interest pairing that recovers
those rate observations.

### Phase 4 — Hardening, i18n, docs, e2e

See 6.7 for what the implementation settled differently from this plan.

| ID | Task | Depends | Size | Status |
|----|------|---------|------|--------|
| M4.1 | Performance/memory pass with the real Sunset file via the harness: batch sizes, progress cadence, peak RSS; document `MNY_IMPORT_LIMIT_MB` + helm memory guidance. Acceptance: 37k transactions + 68k prices < 3 min end-to-end; peak RSS < 3x file size; numbers recorded in docs | M2.4 | M | **done** for what this repository can settle: the progress cadence is fixed, the sizing guidance is written, and both the harness and the import now measure themselves. The acceptance numbers are the maintainer's run against the real Sunset file — see 6.7 |
| M4.2 | Failure-path hardening: corrupt file, truncated upload, pod kill mid-import (reaper + retry), staged-file expiry mid-wizard, double-start guard. Every failure has a localized message and a next action | M1.7 | M | **done** (four defects found and fixed; see 6.7) |
| M4.3 | Full localization pass: all new frontend `import` keys in all 23 locales, backend error keys in all 13; parity suites green; pseudo-locale regenerated. (Single pass at acceptance, per the project i18n workflow) | M1–M3 UI final | M | **done** — three keys, because each earlier phase was localized as it landed. No new backend keys: the error taxonomy already carried every message the new surfaces show |
| M4.4 | Playwright e2e: upload `money2001.mny` through the full wizard, plus the passworded variant; accept-string assertions finalized | M1.9 | M | **done** (`e2e/tests/import-mny.spec.ts`; the passworded variant is `money2008-pwd.mny`, not `money2001-pwd.mny` — see 6.7) |
| M4.5 | Docs: `docs/import-ms-money.md` user guide (incl. v1 limitations: no merge/dedupe, FX cost-basis caveat); adopt PR #192's `ms-money-data-model.md` into `docs/` with attribution and the corrections from this design (act table, phantom rule, SEC_SPLIT); README feature bullet; release notes; close/supersede PR #192 and issue #173 with pointers and credit | all | S | **done** except the last clause: the guide, the adopted format reference, the README bullet and `docs/release-notes/1.14.0.md` are committed. Closing PR #192 and issue #173 is the maintainer's to do — it is an outward-facing action on someone else's contribution, and the credit belongs in a comment written by the person merging |
| M4.6 | Optional stretch: one-time offline generation (jackcess-encrypt, never in the build) of a tiny purpose-built fixture exercising transfer splits, act 4/15/16 pairing, SEC_SPLIT, bills; commit as `synthetic-edge.mny` with a driving integration spec. Skip if impractical | M0.1 | M | **not done** — explicitly optional, and it needs a Java toolchain to author the fixture. The paths it would cover are exercised by plain-object fixtures today; a real file from the maintainer closes open questions 12.3 and 12.4 more cheaply |

#### 6.7 Phase 4 findings

**Every failure path had a hole, and each one ended somewhere with no next
step.** M4.2 was written as a checklist to confirm; it turned up four defects
instead.

- *A damaged or half-uploaded file threw an untyped error.* Table rows are read
  lazily, page by page, long after the table definition resolved, so the guard
  in `wrapTable` never saw it and mdb-reader's own `Wrong page type` escaped
  from `MnyTable.rows()`. `/import/mny/parse` then 500'd with no code for the
  wizard to branch on, and a running job recorded the failure as **retryable** —
  offering Try again on a file that can never import. The fixture proves it:
  page 34 of `money2002.mny` is `ACCT` row data, not its definition, so
  corrupting it leaves the catalogue and the definition readable and fails only
  on the read.
- *A `pending` job was never reaped.* `start` inserts the row and claims it from
  an unawaited task, so a pod dying in between left it pending forever — and
  `hasActiveJob` counts pending, so that one row refused every future import
  that user ever started, with no recovery short of a DBA. The reaper now takes
  pending rows on the same staleness rule measured from `created_at`, and
  `start` fails the job directly when the claim itself throws rather than
  leaving the user wedged for five minutes.
- *A failed start was invisible.* The staged file expiring under an abandoned
  review step, or a second tab already importing, produced a perfectly good
  localized error that nothing rendered: pressing Start import did nothing at
  all. The review step shows it, and offers the way back to upload when the
  staged bytes are what is gone.
- *Two concurrent starts imported the same file twice.* `start` counted the
  user's active jobs and then inserted a row in a second transaction, so two
  overlapping requests both read zero and both inserted. Each parse
  pre-generates fresh transaction UUIDs, so nothing downstream deduplicated the
  loser's rows: the user's history and every balance doubled, and with
  `wipeExistingData` both requests could reach the destructive wipe. The count
  is advisory now; the refusal is a partial unique index on
  `import_jobs(user_id) WHERE status IN ('pending','running')`, and the wipe
  moved behind it.
- *Retry after a "start fresh" import asked for the wipe again.* The wipe runs
  in `start`, outside the job body, so by the time a job can fail the data
  is already gone — and Retry deliberately collects no password, being one click
  on a failure screen. The repeat request therefore failed re-authentication and
  left the user on a retryable failure they could not retry.

**Progress was being written far faster than anything could read it.** Each
writer reported after every chunk of 500 rows: 74 reports for the Sunset file's
transactions and 136 for its prices. None of them is a cheap update —
`reportProgress` deliberately escapes the import transaction, so each takes a
*second pool connection* and opens its own transaction while the long one is
still open — and the wizard polls every 1500 ms, so all but a handful are
overwritten unread. `throttleProgress` rate-limits to one report per second,
always letting the chunk that completes a phase through so the bar never stops
short of the total it reached. Chunk sizes were left at 500: the parameter
arithmetic has plenty of headroom, but raising them is a change no measurement
in this repository can justify.

**The default Helm memory limit cannot import a Money file.** `150Mi` suits
ordinary use; a `.mny` upload is buffered in memory and decrypted in place, so
peak usage is roughly twice the file size on top of the baseline. A pod that hits
its limit mid-import is OOM-killed and the wizard reports a *stalled job*, which
names the symptom and not the cause. `helm/README.md` now carries the sizing rule
(`2 x MNY_IMPORT_LIMIT_MB` plus headroom, so 1Gi at the default 300) and
`MNY_IMPORT_LIMIT_MB` is a first-class chart value rather than something to pass
through `extraEnv`.

**The e2e found that no `.mny` import had ever worked through the wizard.** The
first CI run of M4.4 failed on the money2001 end-to-end test: the preview
parsed fine and the job then died with `mnyUnreadableDatabase`. The cause is
ADR-2 meeting ADR-6. `POST /parse` decrypts the upload **in place** and stages
*that* buffer, because staging plaintext is what lets the password be spent
once and never persisted (ADR-7). The job then re-parses those staged bytes
through `openMnyFile`, which decrypts again -- and RC4 is symmetric, so the
second pass re-encrypts pages 1..0xE.

What made it survive three phases is the test data, not the test coverage:
every integration test staged **raw fixture bytes**, so the job's decrypt was
the only decrypt and the path was green. The fix is a second, explicitly named
entry point (`openDecryptedMnyFile`, reached from `parse({ alreadyDecrypted:
true })`); page 0 is never encrypted, so the scheme and password state still
read from it. The integration suite now stages what the controller stages, and
one spec performs the controller's exact sequence -- parse the upload, stage
that same buffer, import it. The rule is in the module README: a test that
stages anything other than what `POST /parse` stages is not testing the import.

**The passworded fixture the task list names is the wrong one.** M4.4 asks for
`money2001.mny` plus "the passworded variant", which reads as
`money2001-pwd.mny`. That file opens with no prompt at all: Money's pre-2002
"old" key derivation takes no password, so a `-pwd` file of that vintage is
indistinguishable from an unprotected one to anything downstream. The only
fixture that can drive the password prompt is `money2008-pwd.mny`.

**The upload step had the same hole the review step did, in the place most
likely to be hit.** A `.mny` that would not open — wrong file, Money 97, damaged
— left the user on the upload step with nothing shown at all, while every other
parse failure in this wizard toasts. It is a panel rather than a toast because
the useful messages are instructions ("open and save it once in Money Plus
Sunset, then import the result") and a toast takes those away mid-sentence.

**The acceptance numbers can only come from a file that cannot be committed**, so
both ends of the pipeline now measure themselves. `npm run mny:inspect` prints
stage timings and peak RSS as a multiple of file size; a real import logs one
`.mny import timing:` line with load/parse/write/finalize splits, row counts and
the same RSS ratio. Running either against the real Sunset file is what closes
M4.1's 3-minute and 3x-RSS acceptance, and the numbers belong in this section
when it happens.


Dependency spine: M0.2 -> M0.3 -> M0.4 -> {M0.5, M1.3}; M1.x converge on M1.8/M1.9; Phases 2 and
3 parallelize after M1.8; Track B is fully parallel. Each phase leaves `main` shippable — the
wizard simply gains capability per phase.

## 10. Test strategy

- **Layer boundary is the strategy**: only `msisam-decrypt` and the reader layer need real `.mny`
  bytes (jackcess fixtures). Mappers and writers operate on typed row objects — loan splits, act
  pairing, symbol collisions, bill filtering are all plain-object unit fixtures. This is what
  makes the coverage gates (backend 95/94/95/85, frontend 91/90/87/85) reachable.
- **Phase 0**: decrypt specs across all five fixtures (both passworded, one wrong-password);
  reader specs assert table lists, row counts, and the per-version column matrix; date
  normalization property tests (day-00 sentinel, pivot boundaries if still relevant, `YYYY-MM-DD`
  output per the repo DATE convention).
- **Phase 1**: mapper unit specs (every `at` value, phantom rule, transfer/loan-split scenarios,
  referenced-only filtering); controller contract specs (multer limits, password taxonomy, no
  password echo); job concurrency specs (double-claim, reaper); writer integration spec on the
  backend Postgres harness importing `money2008.mny` and asserting balances equal parser-computed
  values; the QIF regression suite guards the `postImportProcessing` extraction; frontend Vitest
  mirrors `MultiAccountReviewStep` test patterns.
- **Phase 2**: per-act-code fixtures; 15/16 pairing and SEC_SPLIT specs; LOT cross-check
  (agreeing + seeded-mismatch); integration spec asserting `HoldingsService` output equals
  LOT-derived holdings; price-dedupe determinism; 68k-price batch performance smoke.
- **Phase 3**: table-driven bill-filter specs over the `st`/date matrix from M0.6; Money 2001
  absence; frequency mapping incl. downgrade warnings.
- **Phase 4**: Playwright e2e with the committed Money 2001 fixture (smallest) through
  upload -> review -> import -> verification, plus the password variant; chaos/failure
  integration specs; i18n parity suites.
- **Acceptance for the feature as a whole**: the M0.5 harness run on the maintainer's real Sunset
  file and the Money 2001 file from the PR thread reports **all per-account deltas zero or
  explained** (each non-zero delta traced to a documented limitation).

## 11. Risks

| Risk | Mitigation |
|---|---|
| Plan A decryption fails on some vintages (old-encryption or MD5-flag files) | Fixtures span 2001–2008; Plan B is a local codec patch in the vendored reader; Phase 0 is a hard gate before dependent work starts |
| Vendored mdb-reader has gaps on MSISAM-specific structures or very large files (usage maps, long-value pages) | M0.5 runs the real 200 MB-class Sunset file before Phase 1 begins; vendoring allows surgical patches; upstream issues filed as found |
| Undocumented act codes in the wild | Unknown acts are skipped with counted warnings in the report, never guessed; harness surfaces them from real files in Phase 0 |
| BILL `st` semantics guessed wrong | The wizard's bill checkbox list is the safety net — users confirm the selection; M0.6 validates against known ground truth first |
| One long import transaction (locks/bloat under concurrent use) | v1 targets fresh/wiped profiles; if harness timing demands it, split into a transaction per phase (reference data / transactions / investments / bills) as a contained follow-up |
| Vendored code drift vs upstream | `VENDORING.md` with version pin and zero-diff policy; upstreaming the MSISAM codec is the exit path |
| Coverage/lint gates vs vendor code | Exclusions land in the same PR as the vendor copy (M0.3) |

## 12. Open questions (owner: Phase 0 spike, M0.6, unless noted)

1. ~~`DHD` base-currency field name/shape.~~ **Answered (M0.4):** `DHD.hcrncDef`, a `CRNC` handle.
   `hcrncCur` (display currency) is null in every sample file. See 6.2.
2. ~~`CAT` income/expense signal: explicit flag, root-ancestor classification, or transaction-sign
   heuristic.~~ **Answered (M0.6): `lType` is an explicit flag** — `{2, 3}` income, `{0, 1}`
   expense, `-1` the two roots, with no crossover in 349 fixture categories. Root-ancestor
   classification is the fallback for the roots themselves. See 6.3.
3. Exact `BILL.st` active values, and whether BILL rows are series or instances (drives the
   dedupe key). Ground truth: kenlasko's file must yield ~20 active candidates. **Blocked on a
   real file:** `BILL` is empty in every committed fixture. `BILL` has both `hbillHead` (series)
   and `iinst` (instance), which is suggestive but not proof; `mny-model.ts` deliberately exports
   no `st` constant until this is observed.
4. act=5 vs act=3 distinction, act=14 real-world meaning (defaults chosen: REINVEST /
   CAPITAL_GAIN + warning). **Blocked on a real file:** the fixtures only exercise act 0, 1 and
   15. Both codes are listed in `MNY_UNCONFIRMED_ACTIONS` so every transaction mapped through them
   carries a warning.
5. ~~Whether mdb-reader's native Jet datetime decoding fully obsoletes the MM/DD/YY 70-year-pivot
   logic.~~ **Answered (M0.4): yes.** Dates arrive as absolute-epoch `Date`s; the real sentinel is
   year 10000, not a two-digit-year pivot. See 6.2.
6. Product (decided here, revisit in review): per-account currency override offered in the review
   step (yes — cheap); closed accounts included by default (yes).
7. Deferred product questions, documented as limitations: merge/dedupe into populated profiles;
   `.mbf` backup support; act=14 category inference.

## 13. References

- PR #192 (`poc/import-from-dotmny`) and its comment thread; issue #173 — the requirements
  source, tester feedback, and the `ms-money-data-model.md` schema reference (marksimpson).
- `mdb-reader` (npm, MIT) — Jet/ACE reader with MSISAM format detection:
  https://github.com/andipaetzold/mdb-reader
- jackcess / jackcess-encrypt (Apache-2.0) — MSISAM crypt algorithm reference
  (`MSISAMCryptCodecHandler`) and the `.mny` sample fixtures:
  https://github.com/jahlborn/jackcessencrypt
- sunriise (hung-le) — the Java exporter the PoC shelled out to; useful cross-reference for
  format behavior: https://github.com/hung-le/sunriise2-misc
- In-repo: `docs/future-plans/row-level-security-tasks.md` (task-list conventions this document
  follows), `ms_money_portfolio_columns.md` (Money Portfolio Manager column semantics),
  `backend/src/import/` (wizard/import architecture being extended).
