# Frontend Directory

Next.js App Router application. All commands run from this directory.

Two cross-layer contracts in `docs/` bind this layer, and both have been violated here before. [`docs/system-invariants.md`](../docs/system-invariants.md) indexes them and records whether the code currently upholds each:

- [`docs/financial-semantics.md`](../docs/financial-semantics.md) -- a figure the server could not compute must not be rendered as a measured one, splits are validated at the storage precision (4dp, not cents), and a stored override price is never replaced by a fresh quote as a side effect of opening a dialog (INV-OCCURRENCE-002).
- [`docs/verification-contract.md`](../docs/verification-contract.md) -- where a mistake is mechanical, the durable guard is a source scan rather than a test of one component. `src/test/ui-conventions.test.ts` is the pattern; INV-CACHE-001 is owed one, because `invalidateBalanceCaches` drops two cache prefixes and `budgets:` is not among them.

## Commands

```bash
npm run dev                # Dev server (port 3000)
npm run build              # Production build (standalone output for Docker)
npm run lint               # ESLint
npm run type-check         # tsc --noEmit
npm run test               # Vitest (single run)
npm run test:watch         # Vitest (watch mode)
npm run test:cov           # Coverage report (91% lines, 90% stmts, 87% funcs, 85% branches)
npm run i18n:pseudo        # Regenerate the xx pseudo-locale from en
npm run i18n:check         # Verify the pseudo-locale is up to date (CI gate)
```

## Layout

`src/` contains `app/` (App Router routes), `components/` (feature-organized React components plus shared `ui/`), `contexts/`, `hooks/`, `lib/` (axios API clients and utilities), `store/` (Zustand: `authStore`, `preferencesStore`, `demoStore`), `types/`, `test/`, and `proxy.ts`. Use the filesystem or LSP `workspaceSymbol` to discover specific files.

## Configuration

- **Path alias:** `@/*` maps to `src/*` (tsconfig + Vitest resolve alias)
- **TypeScript:** ES2017 target, strict mode, bundler module resolution, React JSX
- **Vitest:** jsdom environment, 30s timeout, V8 coverage provider; thresholds 91% lines, 90% statements, 87% functions, 85% branches
- **Tailwind CSS v4:** Via `@tailwindcss/postcss` in `postcss.config.js`, `@import "tailwindcss"` in `globals.css`
- **Next.js:** Standalone output (Docker), strict mode, security headers in `next.config.js`

## API Layer (`src/lib/`)

**Central client** (`api.ts`): Axios instance with `baseURL: /api/v1`, `withCredentials: true`, 10s timeout.

**Interceptors (non-obvious behavior):**
- **Request:** Reads `csrf_token` cookie, injects `X-CSRF-Token` header
- **Response (403 CSRF):** Transparent refresh via `/auth/csrf-refresh`, retries request
- **Response (401):** Token refresh via `/auth/refresh`, queues concurrent requests during refresh
- **Fallback:** On refresh failure, logs out and redirects to `/login`

Feature API modules (one per feature, typed axios wrappers) live alongside `api.ts`.

### A paged endpoint is never asked for more rows than it accepts

`API_MAX_PAGE_LIMIT` (`lib/api-page-limits.ts`) is the ceiling both paged list endpoints enforce, and neither clamps: `GET /transactions` and `GET /investment-transactions` answer **400** to a larger `limit`. These calls sit behind `.catch()`es that degrade to an empty list, so the rejection reaches the user as a figure that is quietly zero (`limit: 500` on the recurring-charges panel is issue #1229; the same literal reported every year's dividends as $0.00).

Lowering the literal to the cap is **not** the fix -- that trades a visible zero for a plausible undercount. Either walk the pages (`transactionsApi.getAllPages`, `investmentsApi.getAllTransactionPages`, both defaulting their page size to the constant) or narrow the query server-side until one page is genuinely enough. Prefer narrowing to walking: a page walk that pulls a year of rows to distil a handful of ids is a side panel paying for a report.

`src/test/api-page-limits.test.ts` scans for call sites above the cap and checks the constant against **both** backend sources. Its known-violation register tracks defects with the change that fixes them, and fails once a violation is gone, so a stale entry cannot outlive its fix.

### A filter the server can apply is not a list the client enumerates

`transactionsApi.getRecurringCharges` takes an `accountId`; it used to take only `payeeIds`, so the panel sent back a payee-id list whose size grew with the account (~250 payees exceeded proxy request-line limits; ~430 exceeded Node's header budget) and the failure arrived as "no recurring charges". The tell is a client that fetches rows **only to extract ids from them** -- that is an account-shaped question asked in the shape of an id list. Send the narrow thing the server can filter on; an array parameter is for a bounded set the caller genuinely holds.

Two obligations come with moving a filter server-side: the endpoint must **authorize** what it now accepts (an `accountId` is a new door, so it goes through the same own/joint resolution the register uses, `resolveOwnContextJointScope`, and a joint account's detection runs as its owner), and the *meaning* usually sharpens (detection scoped to an account measures cadence from that account's own rows). Say which you intended, and test it.

### A write that moves money calls `invalidateBalanceCaches()`

`accountsApi.getAll`, `investmentsApi.getPortfolioSummary` and the budget progress views are cached in `apiCache.ts`, and the backend computes all three live from transaction rows -- a write that does not drop those entries leaves stale figures that even navigation cannot fix (the refetch on mount is served from the same cache). Call `invalidateBalanceCaches()` after any write that adds, removes, re-dates, re-prices or voids a transaction. "Goes through `transactionsApi`" is not the test: posting a scheduled transaction, editing splits (a split can carry a `transferAccountId`), an investment trade hitting its INVESTMENT_CASH account, and QIF/OFX/CSV/MNY imports all write transaction rows from their own modules. `src/lib/balance-cache.guard.test.ts` scans for the omission.

**The prefix list inside the helper is the other half of the rule.** It covers `accounts:`, `investments:` and `budgets:` -- three views of the same rows. Adding a cached family that reads transaction rows means adding its prefix in `invalidateBalanceCaches` in the same change; `apiCache.test.ts` pins the set. Pinning alone is not enough (that is what was green while `budgets:` was missing), so `cache-prefix-classification.guard.test.ts` scans `src/` for every prefix any cache call uses and requires each to be classified as transaction-derived (dropped) or reference data (kept); a prefix in neither list fails, and so does a listed prefix nothing uses.

Where the write can touch anything -- undo/redo, an AI assistant action, a backup restore -- use `clearAllCache()`; no prefix is narrow enough. This matters most for `notifyUndoRedo`/`notifyAiAction`: a refetch served from a stale cache makes the whole signal a no-op.

## Proxy (`src/proxy.ts`)

This is Next.js middleware (NOT the deprecated middleware pattern from this project's conventions). It handles:

- **API routing:** `/api/*` proxied to `INTERNAL_API_URL` (default `http://localhost:3001`)
- **CSP nonce:** Per-request nonce generated in `x-nonce` header, used by Next.js for inline scripts
- **Auth redirects:** Unauthenticated requests to protected routes redirect to `/login`
- **Security headers:** CSP with `strict-dynamic`, nonce-based script-src
- **Public paths:** `/login`, `/register`, `/auth/callback`, `/forgot-password`, `/reset-password` (no auth required)

## Component Patterns

- All interactive components use `'use client'`. Server components are the default for pages/layouts.
- Use dynamic imports for heavy components: `dynamic(() => import('./Chart'), { ssr: false })`.
- `ProtectedRoute` (`components/auth/ProtectedRoute.tsx`) wraps authenticated pages.
- **No `setState` in `useEffect`** — ESLint rule `react-hooks/set-state-in-effect` is enforced. To reset child state when a prop changes, use the "info from previous render" pattern (track the prop in `useState` and update during render).
- **Dialogs use `Modal`** (`components/ui/Modal.tsx`) — handles Escape, focus trap, body scroll lock, focus restore, and stacked-modal popstate. Opt into `pushHistory` so the browser back button also closes. `ConfirmDialog` forwards `pushHistory` for stacked confirm flows.

## Reusing existing UI patterns

Each of these exists once. Use it; do not hand-roll a second one. Every rule here was added after an agent wrote the generic version and a human had to point it out.

### A panel card is `Card` / `CARD_CLASS`, never an inline class trio

`components/ui/Card.tsx` is the one card surface -- background, radius, shadow, and the border that keeps a card legible on themes where the weakest shadow disappears. Use the `Card` component where a plain wrapper works (`padding="md"` matches the widget shell) and `CARD_CLASS` where the element already exists. The old inline `bg-white dark:bg-gray-800 rounded-lg shadow` trio survives in a recorded, shrink-only baseline in `ui-conventions.test.ts`; converting a file means deleting its baseline line. Everything stays on the gray ramp so the colour themes re-skin it -- never add a literal hex or an off-ramp hue to a card.

**Do not drop the border to make surfaces match.** Card-versus-page luminance is ~1.0 in `default` light, `midnight` and `highcontrast` (page and card both pure white there), so the border is the only thing that defines a card at all in those themes -- removing it makes panels disappear, and the change looks safe from every theme except the three it breaks.

### A category's colour and icon are inherited, and drawn by `CategoryGlyph`

Both are resolved server-side in one walk up the ancestry: read `category.effectiveIcon ?? category.icon`, never the raw column (null for most leaves). `components/categories/CategoryGlyph.tsx` draws the result: icon when there is one, colour dot otherwise, dimmed when inherited. Never interpolate `category.icon` into text -- it is a name like `shopping-cart`, so `{category.icon} {name}` renders the icon's *name*. A surface holding a *joined* category row (a transaction, a payee's default category) has no inherited value, so it reads `buildCategoryIconMap` / `buildCategoryColorMap` (`lib/categoryUtils.ts`) built from the full category list, as the register does.

### A brand favicon is `BrandLogo`, addressed by its entity's wrapper

`components/ui/BrandLogo.tsx` renders a cached favicon with the neutral badge fallback, and owns the one rule that matters: the bytes always come from our own backend, never a third party, so drawing a logo cannot leak which institutions or payees a user has. `InstitutionLogo` and `PayeeLogo` are thin wrappers naming the `/:id/logo` route, gated on `hasLogo` so icon-less rows issue no requests. A 404 lands on `onError` and shows the same badge. A third entity gets a wrapper, not a second component.

**Hiding a logo responsively is spelled `max-sm:hidden`, never a bare `hidden`.** Tailwind emits `.hidden` *first* among the display utilities, so on the fallback badge -- whose own classes include `inline-flex` -- a caller's `hidden sm:inline-flex` never hides anything: the letter circles stayed visible on mobile while the favicons vanished. A `max-*` variant sorts after every base utility and wins below its breakpoint. The brand-logo guard in `ui-conventions.test.ts` fails on a bare `hidden` token in any logo call site's `className`.

### A status pill is `Badge`; table chrome is `Table.tsx`

`components/ui/Badge.tsx` is the small status pill (previously hand-rolled ~50 times). Pass `variant` and `size`; pass `as="button"` where the pill is also a control, rather than nesting a button in a span. It deliberately does not absorb pills whose colour *means* something -- `CategoryPill`, `AccountTypePill` and `SCHEDULED_KIND_CHIP_CLASSES` are each already one source of truth, exempted by name.

`components/ui/Table.tsx` is constants (`TABLE_CLASS`, `TH_CLASS`, `TD_CLASS`) plus thin `Th`/`Td` cells, not a `<Table>` wrapper -- these tables are hand-laid with colspans and sticky cells. `SortableHeader` deliberately stays off `TH_CLASS` (about twenty-five report tables draw a lighter header, and folding it in would restyle every report).

### The card shadow is `--shadow-card`; the bare `shadow` reads no token

Tailwind v4 trap: the bare `shadow` utility is a legacy alias with the stock value compiled in, so redefining `--shadow-sm` in `@theme` touches `shadow-sm` (worn by form fields) and leaves cards flat. `ui-conventions.test.ts` fails on a `--shadow-sm` redefinition. Card elevation goes through `--shadow-card`, worn by `CARD_CLASS`.

### A focus ring is `focus-visible:`, and a hover animates

`focus:ring-*` paints on a mouse click as well as a Tab; use `focus-visible:` on anything clickable. Text inputs are the one exception (`inputBaseClasses` and the element selectors in `globals.css`). Row hover comes from `HOVER_ROW_ON_CARD` / `HOVER_ROW_ON_PAGE` in `Card.tsx`, not a hand-picked grey, and includes the transition (a hover that snaps reads as a redraw). Pair any new transition with `motion-reduce:transition-none`. Both rules carry shrink-only baselines in `ui-conventions.test.ts`.

### A dialog is titled through `Modal`, never by a hand-rolled heading

`Modal` takes `title` (and optional `description`, `footer`, `padding`), draws the standard header and wires `aria-labelledby` -- before it, none of the 74 hand-rolled headings reached the dialog, so every dialog announced itself as an unnamed region. `padding` defaults to `none` and leaves children unwrapped, because several call sites make the panel their own scroll or flex parent. A genuinely bespoke header (ConfirmDialog's icon) stays on the baseline deliberately.

### An empty list renders `EmptyState`

`components/ui/EmptyState.tsx` (glyph, title, optional description and action). `ui-conventions.test.ts` bans the `text-center py-12` container fingerprint outside the component, with no grandfathered baseline.

### An auth screen renders inside `AuthShell`

`components/auth/AuthShell.tsx` is the single shell for login, register, forgot/reset/change-password, verify-email and setup-2fa: transparent brand mark, title/subtitle, notices slot, shared `Card` around the body (`plain` for a bare status line). Language picker and version line are opt-in props. Use `/icons/monize-logo-transparent.svg` everywhere in the UI -- the boxed `monize-logo.svg` bakes in a white background and renders as a white square in dark mode. Guarded in `ui-conventions.test.ts`.

### Navigation links and their icons live in `lib/nav-links.ts`

The header's link arrays and the per-route Heroicon map are declared side by side so `nav-links.test.ts` can hold "every nav route has an icon". The mobile drawer and header dropdowns render `NAV_ICONS[href]`; the desktop top-bar pills stay text-only on purpose (six leading icons overflow 1280-1440px laptops). A new route means one entry in the array and one in the map, in the same file.

### Account-type colour and icon come from `lib/account-type-meta.tsx`

`ACCOUNT_TYPE_META` maps each account type to its pill classes and Heroicon; render `AccountTypePill` / `AccountTypeIcon` rather than re-deriving either. `ui-conventions.test.ts` fails on a second type-to-pill-class mapping. An account with no institution shows its type icon in the brand-badge slot (`InstitutionLogo`'s `fallbackIcon`), not a generic glyph.

### A register's category chip is `CategoryPill`

`components/transactions/CategoryPill.tsx` owns the colour-mix pill and the category's optional icon (via `getIconComponent`, as tag chips do). Categories carry `icon` end-to-end -- `CategoryForm` collects it through the shared `IconPicker` (whose `onClear`/`clearLabel` props make "no icon" a real state) -- so a surface showing a category name with its colour shows its icon too, and an unset icon renders nothing, never a default glyph.

### A dashboard widget header carries its icon from `widget-meta.tsx`

`WIDGET_ICONS` gives every registered widget a distinct Heroicon (`widget-meta.test.tsx` enforces coverage), rendered as the tinted `WidgetIconPuck` -- blue ramp only, so themes re-tint it. Widgets on `WidgetCard` get it from their `widgetId`; a widget drawing its own header uses `WidgetHeading`, which also owns the title-button markup.

### Date entry -- `DateInput`, never a raw `<input type="date">`

`components/ui/DateInput.tsx` is the only place a raw date input is allowed; `ui-conventions.test.ts` fails the build if another appears. It carries lenient parsing of typed text, keyboard shortcuts, and `CalendarPopover`. Key behaviors:

- **On desktop it is a text box regardless of format preference** -- the pointer decides the mode, not the format (touch keeps the native picker). The native control's segment-jumping entry is issue #1201.
- **`browser` is not a pattern, and nothing below `useDateFormat` should see it.** `datePattern` off that hook is the concrete arrangement, resolved by `resolveDateFormatPattern` (`lib/date-parse.ts`). `parseFlexibleDate` takes the pattern (7/8 is ambiguous without it); `parseDateFromFormat` stays strict for canonical values.
- **A partial entry is completed, and an unreadable one changes nothing.** Day+month take the year from the field's current date (today when empty); a lone number is a day in the month on screen; unparseable text restores what was there -- clearing the box is the only way to mean "no date". None of this happens on the keystroke: the lenient reading waits for blur or Enter.
- **A screen hosting a date field does not answer a load with a second tree.** `if (isLoading) return <Skeleton/>` unmounts the field being typed into; render load/error states *inside* the one tree. Duplicating the controls block into the second `return` is not a fix (different child indexes still reconcile wrong -- `CashFlowReport` did this). `ui-conventions.test.ts` fails both shapes for any component pairing a date control with a `useReportData` loading flag; a one-shot prerequisite load (the report *forms*' `isLoadingData`) is deliberately not policed.

### Currency entry -- `CurrencyInput`, never a raw number input

`components/ui/CurrencyInput.tsx` is the only way to take a money amount: a `type="text"` field with `inputMode="decimal"` that filters as you type, formats with separators on blur, clears a `0.00` on focus, parses through `parseAmount` (rounded to cents), re-syncs on external value changes, and accepts inline calculator expressions (`100*1.13` + Enter/blur) plus a calculator modal. Props: `prefix`, `allowNegative` (default true), `allowCalculator` (default true), `allowSignToggle`. For non-money numbers (share counts, rates, percentages, day-of-month) use `NumericInput`: same filtering, with `decimalPlaces`, `suffix`, `min`/`max`, `allowNegative` defaulting false, no calculator.

`ui-conventions.test.ts` fails the build on any `<input type="number">` or `<Input type="number">` -- resolving the tag each `type="number"` belongs to, because recharts' `<XAxis type="number">` is not an input and is left alone.

Both components take a *number* (`value: number | undefined`, `onChange: (value: number | undefined) => void`):

- **`register()` does not fit.** Wrap in react-hook-form's `Controller` and pass `value`/`onChange`/`onBlur`/`ref` (plus `name={field.name}`, or `name`-based test selectors stop matching). Where the schema stores a string, bridge inside the render callback.
- **`min` clamps while typing; `max` only on blur.** Every prefix of a number is smaller than the number, so a ceiling must not fire mid-word -- and `min` is wrong for a multi-digit floor (`min={2}` eats the `1` of `14`): leave it off and let Zod report. Where an out-of-range value must be *discarded* rather than trimmed, keep the explicit range check in the component's `onChange` (`MortgageFields`, `BudgetWizardStrategy`).
- Give each field an explicit `id` when two on one screen share a label -- both components derive `id` from the label text, so a repeated "Years"/"Months" pair collides.

**A field that hands back its own value has not been edited.** Both components re-parse the on-screen text on blur, and for an untouched field that text *is* the parent's value formatted -- reporting it is destructive to parents that do more than store it (the FX panels derived a rate from the cents-rounded total and marked it user-overridden). Both notify only when the value actually moved (`notifyIfChanged`), and both carry a blurred-untouched regression test. The general rule: **an `onChange` that does more than store the number must also be idempotent** -- guard the side effect on the value having changed at the handler too (`handleConvertedTotalChange` returns early when the incoming total equals the derived one).

### A clickable table row -- `useLongPress({ onClick })`

`useLongPress` takes `onClick` alongside `onLongPress`: a plain click runs the row's primary action, a 750ms press (or right-click) opens the mobile action sheet, and a click following a long-press is suppressed. Spread `getRowHandlers(item)` on the `<tr>` and add `cursor-pointer` (accounts, payees, tags, categories, securities lists all do). Do not put the click on a button around the name instead -- the rest of the row becomes dead area. Controls *inside* the row (a favourite star, `RowActions`) must `stopPropagation`.

### A detail page returns to its list above the title, and switches with the caret beside it

Every detail page carries the same two controls: a chevron and "Back to <List>" on the line *above* the title, and `EntitySwitcher`'s caret immediately after the title. The way back is not an action on the thing being viewed, so it does not belong among the buttons on the right. For reports the pair is `BackToReportsLink` and `ReportDetailHeader` (`components/reports/`); `ReportSwitcher` builds the route itself so no call site spells it out. `ui-conventions.test.ts` scans for a hand-rolled back-chevron-to-`/reports`.

**Two switchers on one line means at least one says its name.** `EntitySwitcher` takes `triggerText` (the GEM report's scenario picker reads "Scenario ⌄"); the bare caret stays the default when it is the only one.

**A detail page's actions sit on the title row, not in a row above the body.** `AccountDetailShell` takes `headerActions` for type-specific actions beside the standard set; a signal they need to send the body travels down as a prop (`refreshKey`) rather than keeping the button in the body. A `size="sm"` button in a report toolbar takes `size="md"` in that header.

A switcher list too long to scan takes `group` on its items (`ReportSwitcher` groups in `REPORT_CATEGORIES` order); sections follow the order their first item appears in, so ordering happens in the caller.

### A category picker lists every category in tree order as "Parent: Child"

However a surface selects a category, the option list is one shape: built from `buildCategoryTree` (each parent followed by its children), a child labelled `Parent: Child`, a top-level category by its bare name, and **every row selectable, parents included**. `CategorySwitcher` carries the regression tests.

**A picker the user types into creates through `createCategoryFromInput` (`lib/category-create.ts`), never inline.** It owns title casing and the `Parent: Child` shorthand (create or reuse the parent, then the child), and returns every row it created so the caller can append all of them. The guard in `src/test/ui-conventions.test.ts` fails on a second `categoriesApi.create` call site outside the helper and the Categories page's own full create form.

Whether a picker *offers* to create is a property of the surface, not the field: a form that can create passes the creator to **every** category picker it renders, split lines included (`SplitEditor`'s lines silently discarded unmatched text while the Category field offered "+ Create" -- issue #1187). An asynchronous create addresses the row it came from **by id** (rows can move while the request is in flight), and the new category's `isIncome` comes from what the creator returned.

### An account balance is coloured by its sign -- `balanceColor`, never by account type

`balanceColor` (`lib/format.ts`) is the one rule: negative is red, everything else neutral. Do not add `|| isLiability` (or any `accountType` test) -- a credit card at a credit balance is not in the red, and the sign already carries the meaning. `gainLossColor` is the sibling for a *change* in value (green when up), not for a balance.

### A scheduled transaction has four kinds, not two -- `scheduledKind`

`amount < 0` / `> 0` answers half the question: a **transfer** between own accounts is neither bill nor deposit, and exactly **zero** is a deliberate placeholder for an amount unknown until it arrives. A sign ternary paints the zero green, and a `!st.isTransfer` filter deleted a scheduled transfer from both calendars (issue #1124).

Classify with `scheduledKind` (`lib/scheduled-kind.ts`) -- `bill | deposit | transfer | reminder` -- and colour from `SCHEDULED_KIND_CHIP_CLASSES` / `SCHEDULED_KIND_AMOUNT_CLASSES`. Pass the *effective* amount (`nextOverride?.amount ?? amount`) where the surface is about one occurrence.

A surface listing *occurrences* includes every active schedule whatever its kind. Filtering by kind is for a surface genuinely about bills or deposits, and there a `reminder` belongs in neither bucket -- except where the surface is about *what the user still has to pay*, where a zero-amount reminder counts as an upcoming bill contributing nothing (`BudgetUpcomingBills`). A **money total** is a separate decision from the count: a transfer is counted as upcoming but its amount never joins a bills-and-deposits sum (`UpcomingBillsReport`'s `summary.totalOf`), and a reminder's zero is never given a sign or a red/green treatment.

### A stored occurrence price is an instruction; the market close is a suggestion

An investment price *or quantity* the user saved is a decision, not a stale default: live market data may be *offered* beside it but never *written over* it. `OverrideEditorDialog` auto-fills from the latest close only when the occurrence has no price of its own and the user has not typed a total (`hasStoredPrice` false, `userEditedTotal` false, field empty), otherwise exposing an explicit "use latest close" action. `PostTransactionDialog` skips its market-price refresh when the prefill came from a per-occurrence override (`investmentFromStoredOverride`, keyed off a stored price *or* quantity) or when the user has edited any field (`userEditedInvestment`).

Both fills are **total-first** (issue #1148): they preserve the amount invested and re-derive the share count. The two guards differ because the state each fill runs against differs: the override editor blocks only on a typed **total** (the one state where the fill would rescale the quantity), while the post dialog always carries a total and so blocks on **anything** typed. The fetch is asynchronous -- it can resolve after the dialog opens, and a value typed in the meantime is the user's instruction. A NaN or zero close is not a usable price -- normalize to null where `marketPrice` is set (`usableClose`).

`marketPrice == null` is three states at once (loading, failed lookup, genuinely empty history), so it must not gate the "no price history, enter manually" hint. Each surface carries a `priceHistoryEmpty` flag set true *only* when a request completes with no usable close, reset while in flight, left false on rejection.

Three surfaces fill these fields -- the two dialogs and `ScheduledTransactionForm` -- and all three do the price/quantity/total arithmetic through `lib/investmentFold.ts` (`totalFromQuantity` / `quantityFromTotal`: one rounding scale, one signed commission fold). Never hand-roll the fold; `lib/investmentFold.guard.test.ts` scans for the 8dp share-precision rounding that fingerprints a hand-rolled copy. State a stored price's provenance truthfully ("saved on this occurrence" vs "from the schedule" are different keys); format "latest close" copy through `useNumberFormat().formatPrice` (a price is not money: up to six decimals, Intl-trimmed), never a hand-rolled `toFixed`. Compose any "Label: value" line in the catalog as one string a translator can reorder, never `{t('label')}: {value}` fragments.

`ScheduledTransactionForm` adds two invariants because its `Total Value` is a shown figure that submit recomputes: **the displayed total and the persisted amount must never disagree** -- every field that moves the economic total (price, quantity, **commission, and the BUY/SELL action whose sign flips the fee**) recomputes the shown total through the same fold, and an async close arriving mid-entry preserves a typed total and re-derives the quantity. And **a market price belongs to one security**: changing the selected security clears the auto-filled price and the seen-market-price latch. Gate the "Latest:" placeholder on a positive `roundedMarketPrice`, never a bare `marketPrice != null`, so it never renders "Latest: NaN".

### Two transaction lists, two opposite delete contracts -- read the tense

`InvestmentTransactionList`'s `onDelete` **asks the parent to delete** (the list confirms and hands back an id). `TransactionList`'s `onDeleted` **reports a delete it already performed** (it owns the confirmation, the API call and the toast). A handler written for the first shape and wired to the second deleted every cash row twice (issue #1192) -- worse for a transfer, where the list correctly calls `deleteTransfer` and the parent then calls plain `delete`. Reach for `onRefresh` to reload after a delete, and for `onDeleted` only when you need the id itself -- never to perform the delete. `ui-conventions.test.ts` scans every `<TransactionList` for an `onDeleted` handler that deletes.

**The signal has to reach whatever else is derived from those rows.** The panel's own reload is not the page: the account detail view draws the portfolio summary, allocation and Holdings by Account above the register, and a write that only reloaded the register left all three stale (issue #1190). Dropping caches is half of it -- nothing mounted refetches on its own. `InvestmentRegisterPanel` raises `onDataChanged` after every write, and `InvestmentDetailView` re-runs its load from it.

**Every write path on a page shares one refresh, including the ones nobody reported.** A delete is a write, and so is an undo, a redo, an AI action and a status change; a reported create symptom says nothing about which paths are broken. `useInvestmentData.refreshAfterWrite` is that one function for the Investments page (`InvestmentRegisterPanel.afterWrite` is the detail page's). When you fix a stale-figure defect, grep the surface for its other write paths and route them through the same function in the same commit.

**A sibling that fetches for itself needs the signal as a prop, not as a re-render.** `InvestmentValueChart` fetches its own series, so the write reaches it as `refreshKey`. Two details: the intraday series is served from `sessionStorage`, so drop it (`clearAllIntradayCache`) and pass `skipCache`; and the effect must gate on the key it has already **acted on**, not on running -- `loadData` changes identity on every range/account/currency change, and an ungated second effect double-fetches on each.

**Both registers of one account are paged, filtered and drawn the same way.** The bar above the rows is `ListTopToolbar` (`components/ui/ListTopToolbar.tsx`) -- position info left, density toggle and list buttons right -- and both `TransactionList` and `InvestmentTransactionList` compose it; `ui-conventions.test.ts` fails on a second call site handing `Pagination` an `infoRight`.

**A register pages from both ends, and the second one is `ListBottomPager`** (`components/ui/ListBottomPager.tsx`). On a single page it draws the count instead of an inert pager -- the opposite of the top strip, which keeps its pager because "Showing 1-7 of 7" answers "did that filter work?". The top strip is the card's own header row and belongs inside the list component; `Pagination` carries its own background and shadow and must sit *outside* the card. `ui-conventions.test.ts` fails on a raw `<Pagination>` anywhere but the two wrappers and the four standalone list pages, and separately requires each register surface to reference `ListBottomPager`. Nothing repeats the density toggle down there: repeating a position is the point, repeating a control is not.

Filtering follows the same rule: a trade is narrowed by symbol and action (the brokerage list's own filter row), a cash row by payee and category (`CashFilterBar`, shared by the Investments page and the account detail page). Each register's page returns to 1 when its filter changes, and the filters belong in the register's request key. The chrome is part of "the same way": one heading (*Recent Transactions* on both -- the toggle already says which ledger), a new-row button marked the same on both, the same gaps.

**A filter picker offers what the rows use, and it loads because the register is on screen.** `useCashFilterOptions` asks `transactionsApi.getRegisterFilterOptions` for the payees and categories the selected accounts' rows actually reference. The endpoint reads split lines as well as parents (a split parent's own `categoryId` is NULL), and returns the **ancestors** of every used category, because `MultiSelect` builds its top level from `parentId == null` and drops a child whose parent is absent. Trigger the load from the view being displayed, never from the click that reaches it (the view is remembered, so the register is reachable without the click).

`useBrokerageFilterOptions` (`hooks/useBrokerageFilterOptions.ts`) fetches the actions and symbols those accounts have actually used. Absent or empty is "no information", so the action list keeps offering everything; whatever is selected stays in the control even when the rows no longer use it. **Symbols come from the rows, never from current holdings** -- a position sold in full is exactly what somebody filtering by symbol is looking for.

**A one-shot fetch guarded by a ref cannot also be cancelled in its cleanup.** Under StrictMode (on in Next.js) an effect runs, cleans up, and runs again: the first pass claims the `loadedKeyRef`, the cleanup marks the only request cancelled, and the second pass starts nothing -- pickers sit empty all session. Let the ref decide instead: adopt the response while `loadedKeyRef.current === key` (which also drops an answer a newer selection overtook). Testing Library does not double-invoke effects, so only a test rendering the hook inside `<StrictMode>` catches this; both hooks carry one.

**A register that has rows keeps them while the next page loads.** Gate the skeleton on there being nothing to show yet (`loadedKey === null`), not on a request being in flight (the Investments page's `hasLoadedRef` is the same decision) -- swapping a table for a skeleton scrolls the reader to the top.

**A pager stays drawn when a filter narrows the list to one page.** The buttons are inert, but "Showing 1-7 of 7" is the answer to "did that filter work?", read at exactly the moment hiding it would remove it.

**A nav tab is lit by the section a page belongs to, not by an exact path.** `isNavSectionActive` (`lib/nav-section.ts`) is the one predicate, used by the header and the mobile drawer: `/accounts/<id>` is Accounts, `/securities/<id>` is Tools. The boundary is a slash, so `/accounts` never claims `/accounts-archive`.

**A cash register holds rows that are not cash transactions, and one function decides which editor each gets** -- `editCashRow` (`lib/cash-row-edit.ts`). A trade's cash leg (`linkedInvestmentTransactionId`) is edited as the *trade*; a transfer is fetched in full first (the list payload lacks its counterpart); everything else opens on the row as listed. A failed lookup for a trade opens nothing rather than falling back to the cash form -- the fallback is the same defect by another door.

**A modal this page already mounts is opened, not navigated to.** Clicking an investment-linked row pushed `/investments?edit=<id>`, remounting and refetching everything to reach a form that was mounted the whole time. Fetch the row and call the modal's own `openEdit`; keep the URL parameter for arrivals from another page.

**A form's account list is a property of the form, not of the page that opened it.** `InvestmentTransactionForm` is mounted from two surfaces, and only one passed `allAccounts` -- so "Funds From (optional)" offered only the one option the field exists to replace (issue #1191). When a surface mounts a shared form against a narrower scope, narrow the *scope* props (`accounts`, `defaultAccountId`) and keep supplying the wide ones. A failed lookup stays `undefined`, never `[]`: undefined is "not supplied", an empty array claims the user has no other accounts.

### Row density is remembered per view, by one store -- `useDensityPreference(view)`

Each surface keeps its own level, but exactly one store holds them all. Read it with `useDensityPreference(view)` (`@/store/densityStore`), which returns `density`, `setDensity` and `cycleDensity` bound to that view; pass the level *down* to rows and `RowActions` as a prop, never accept a change callback back up. `DensityView` is a union, so a mistyped view is a compile error. (It was thirteen drifting stores before issue #1193; `densityStore.ts` migrates all twelve legacy keys.)

**A component rendered from more than one surface takes a `densityView` prop.** `TransactionList` is mounted from six places; the prop defaults to the owning page's view, so a caller that forgets it silently shares the register's bucket. The guard fails on a call site outside the owning page that does not pass one.

The preference is browser-local rather than a `user_preferences` column on purpose -- a laptop and a desktop on the same account should not have to agree -- and is classified in `persisted-storage.guard.test.ts`.

**The button is `DensityToggle`, and the strip above a table is `DensityToggleBar`** (`components/ui/DensityToggle.tsx`). The copy lives once, at `common.density.*` (per-surface namespaces let fourteen locales drift, with Korean holding six words for "Dense"). Pass `size` (`sm` above a table, `md` beside `text-sm` toolbar controls, `chip` in a filter-chip row) and `className`; never colour or padding.

**Cell padding is `useTableDensity(density, scale)`**, whose table is data in one file. Two scales are deliberate: `default`, and `wide` for a register with enough columns that the phone inset yields first (the investment register). A third variant means a named entry there, not a `switch` in a component.

`density-preference.guard.test.ts` holds all of it as a scan: a local density `useState`, a density key at any storage call site, an `onDensityChange` prop, a `cycleDensity` not from the store, a shared list rendered without a `densityView`, a second copy of the toggle markup, a density string in any catalog but `common`, and a hand-rolled padding `switch` all fail.

### Asking for the Balance column and supplying the balance are one decision

`<TransactionList isSingleAccountView>` draws the Balance column, and the number in it is the backend's `startingBalance` run down the page -- the list derives nothing, so the column arrives empty without it (issue #1188). Take both from the same response and adopt them in the same block: a starting balance is computed for one page of one account, and a failed reload that keeps the rows has to keep the balance too. `ui-conventions.test.ts` fails any `<TransactionList>` setting `isSingleAccountView` without `startingBalance`.

### An overdue-reconciliation window is the server's number, never the client's

Whether an unreconciled row is *overdue* is decided by `classifyStaleRow` (`lib/stale-reconciliation.ts`), and it takes the boundary date as an argument because the server owns it: every response that asks for a classification carries `overdueBefore` (and `staleAfterDays` for the copy that names it), from `STALE_UNRECONCILED_DAYS` in `backend/src/transactions/stale-reconciliation.ts`. A hardcoded number goes on saying 45 after the constant moves, and the row highlight then disagrees with the header badge.

**Which of its two answers a surface *draws* is the surface's decision** -- the register draws `missed` only (`registerStaleReason` in `TransactionList.tsx`; "overdue" is true of every row at once on a page of history), `ReconcileTable` draws both, the header badge counts both. That presentation choice is the *only* thing a call site may vary. Three things the helper decides that a call site must not re-decide:

- **An account nobody reconciles has no overdue rows** (`lastReconciledDate` null is the whole test) -- reconciliation is opt-in.
- **`missed` wins over `overdue`** -- a row counted under both makes the reminder's lines add up to more than the badge.
- **A RECONCILED or VOID row is never outstanding** -- the status test lives inside the helper.

**A failed lookup is not a clean ledger.** `useStaleReconciliation` returns `undefined` on failure, and every consumer reads undefined as "no information" and marks nothing. An empty context instead would make an outage indistinguishable from an up-to-date ledger -- the same class of mistake as `accounts = []` on a failed request.

### A long list -- page it, or bound it and scroll with `scrollbar-slim`

A full-page list uses `components/ui/Pagination.tsx`. A list inside a card caps its height and scrolls: `scrollbar-slim max-h-* overflow-y-auto pr-1`. The thing to avoid is the *default* scrollbar, not scrolling -- on Linux/Windows the native bar inside a small card reads as a rendering fault. `scrollbar-slim` (defined in `globals.css` alongside `scrollbar-hide`) keeps a thin themed thumb.

Bound the height rather than letting the card grow or hiding rows behind a "Show N more" expander -- a card in a grid must be the same height whatever its contents (`SecurityWeightingBars` and the detail page's "Held in accounts" are the worked examples). `scrollbar-hide` is for a horizontal chip strip where overflow is obvious; never use it on a vertical list.

### A password field declares what may be autofilled into it

Every `<Input type="password">` carries an `autoComplete`: `current-password` when it really is this account's password, `new-password` when one is being set here, `off` when it is not a credential of this site at all. Omitting it is not neutral -- a password manager fills a bare box with the saved credential, and the form submits it as typed: the AI provider's API key field silently replaced the stored key ("Saved" on screen, provider dead, row shows `****` either way), and the backup export password is the same shape and worse. `ui-conventions.test.ts` fails on a password input with no `autoComplete`, and on a value outside those three.

### A view that graduates to its own page -- delete the modal, do not flag it

Remove the modal mode instead of keeping it behind a prop: an `onClose?` nobody passes and an `embedded` flag whose only caller always sets it leave every `!embedded` branch compiling, tested and unreachable, still fetching data they no longer show. Delete the props, those branches, the orphaned catalog strings in every locale, and whatever in a shared component only that modal used.

### Copy -- `--` is comment style, never UI text

The repo writes `--` in code comments, and the habit leaks into catalog strings, where it renders literally. In copy use an em dash, or recast the sentence. `messages.punctuation.test.ts` fails the build on a new one (shrink-only baseline for existing). The same applies to anything else that is punctuation rather than words: compose it in the catalog, not in JSX -- `"{units} ({share})"` is one string a translator can reorder; `{value}{' ('}{share}{')'}` is three fragments they cannot reach.

### A transfer's direction comes from the row's own amount -- `transferDirection`

Money leaving an account went **to** the counterpart; money arriving came **from** it. The two legs of one transfer are labelled differently and both are right, and a split line pointing at another account is asked with *its* own amount, not the parent's. `transferDirection` (`lib/transfer-label.ts`) is the only place that decision is made; `transferCsvLabel` is the export's rendering, and the register renders the same decision as its arrow chip. A `ui-conventions.test.ts` guard fails on a new `? 'to' : 'from'` outside the helper.

Coerce before comparing: `'-67.9900' < 0` is false, and a decimal string is what the API sends.

### A transaction's payee display is `usePayeeDisplay`, never a bare `payeeName` read

A transfer created with a blank payee is PERSISTED blank (issue #1214); migration 161 blanked the legacy-stamped rows. The label is resolved at render time: `usePayeeDisplay()` (`hooks/usePayeeDisplay.ts`) returns the stored payee when there is one, otherwise for a transfer leg the localized `common.transferPayee` string built from `linkedTransaction.account.name` -- the counterpart's CURRENT name, so renames and language switches reach every historical row. A surface reading `tx.payeeName || tx.payee?.name` directly shows those transfers as unnamed. English CSV exports use `transferPayeeCsvLabel` (`lib/transfer-label.ts`), byte-identical twin of the backend's `transferPayeeLabel`.

### A CSV file is written by `exportToCsv`, and a number in it is a number

`lib/csv-export.ts` is the only CSV writer: BOM, CRLF, RFC 4180 quoting, formula-injection guard, download. Multi-table exports take `exportCsvSections` (`MonteCarloReport` had a hand-rolled copy that quoted every field and guarded none). `ui-conventions.test.ts` fails on a second `text/csv` Blob or a second `replace(/"/g, '""')`.

The guard cannot key off the first character (`-` opens both a formula and every debit -- issue #1134: Excel refused to total 59 of 64 rows). It asks whether the value *is* a number (optional sign, digits, separators, whitespace, currency symbols, optional `%`), which is provably inert as a formula.

**The reason it reached the user is worth more than the fix.** A prior pass had exempted negative numbers, with a passing test -- but it tested `-100` the JS number, while the API sends the *string* `"-67.9900"` (`decimal(20,4)` crosses the wire as a string while `types/transaction.ts` declares `amount: number`). Two consequences:

- **A money value off the API is a string until you make it one.** `Number(...)` it at the boundary of anything that branches on its type -- an export, a `typeof` check, a `.toFixed`.
- **A test for a type-dependent branch uses the shape the API sends**, not the shape the interface claims (`page.test.tsx` exports a fixture whose `amount` is `'-67.9900'` for this reason).

### Asynchronous data carries the request that produced it

**Asynchronous data is not only a payload. It is the payload plus the complete request key that produced it.** A component holding `data` without knowing which request answered cannot tell "the report you are looking at" from "the report you were looking at a moment ago", and every action it offers is aimed at whichever of the two it happens to read.

The request key is every selector that changes the *meaning* of the response, not merely its freshness: the scenario or strategy id, the account id, the date range, the reporting currency, the active filters, the locale where the server localizes output, and the revision where one exists. If changing it would make the same payload mean something else, it is part of the key.

**Stale data may stay on screen; it may not stay actionable.** Keeping the previous view during a load is often the better read. It is allowed while all of the following hold: it is visually marked as stale or loading; editable controls are disabled; mutations are disabled; no action can submit an id taken from the stale payload under the new selection; assistive technology is told the same thing the pixels say (`aria-busy`). Clearing the screen is not required. Non-actionable is.

**A mutation captures an immutable origin key when it starts**, and its response is adopted only when `mutationOriginKey === currentRequestKey` *and* the entity the response describes is the one the mutation targeted. Derive that origin from the data the component was rendering, not from current React state read after the request began -- state has already moved by the time the response lands.

**A failed lookup is not an empty dataset.** A failed accounts request is not `accounts = []`, and a failed report is not a report of zeros -- rendering the failure as emptiness turns an outage into a plausible answer and leaves the save button live over prerequisites that never loaded. Five states stay distinguishable: loaded-and-empty, loading, failed, stale-previous, and current. Where a prerequisite failed, use the shared retryable error presentation, keep the stored ids, and disable the actions that depend on it.

**A dirty keyed form is data.** Changing the request key while a form has unsaved edits calls for a confirmation, a preserved draft, or an explicit save/discard flow; silently unmounting it is data loss. A form rendered for scenario A must also stop being editable once scenario B is the current selection -- two obligations, and meeting the second by discarding the first is not meeting both.

Regression tests for this class need deferred promises, and must assert on what the user *can do*, not only on what is rendered (`docs/testing-contract.md` carries the wider adversarial list):

| Case | Assertion |
| --- | --- |
| A starts, B starts, B resolves, A resolves late | the display is still B |
| A shown, B selected and loading | A's form cannot submit |
| Save for A starts, user selects B, A resolves | A's response is discarded and does not retire B's request |
| A shown, B selected, B fails | the failure is shown; A is not presented as B |
| Form dirty, user selects B | confirmation is asked for, or the draft survives |
| Save on the default selection, nothing else happens | the response is adopted |

**Both sides of that comparison must come from the same place.** The origin key a mutation captures and the key the loader is holding have to be produced by one expression -- take the origin from what the loader actually stamped (`dataKey` on `useReportData`), never rebuild it from the rendered payload's fields. The GEM report built its page key from a `strategyId` *state* unset until the user picks from a switcher, and the save's origin from `data.strategy.id`, always a real id: they could never match on the ordinary path, so every save was discarded with no refetch behind it. A key comparison that silently drops the common case looks exactly like one that works.

### A busy flag shared by nesting operations is a counter, not a boolean

One mutation can start another ("save and carry on" runs the deferred scenario create from inside the settings save's own `onSaved`). With a single boolean the inner sets it, the outer's `finally` clears it, and the page goes live over a request still on the wire. Count the operations in flight and derive the flag (`pending > 0`); every begin needs exactly one end, on both success and failure paths.

### Nothing interactive goes inside a `<button>` or an `<a>`

The parser closes the outer element at the inner tag, so the click target ends where the nested control begins and the server's HTML stops matching React's -- a hydration mismatch. Fix it at the call site by making the two **siblings**: a wrapper carrying the border and hover, with the navigation button and the nested control side by side. Do not demote the inner control to a focusable `<span>` -- its implicit role is generic, screen readers drop its `aria-label`, and the result is a tab stop announcing nothing. `ui-conventions.test.ts` scans for this; changing a shared component's trigger element is a change to every call site, and the guard tells you which.

### A short-range portfolio change is measured from the prior close

On `1d`, `1w` and `mtd` the Change and Change % measure from the close of the last trading day *before* the window -- the convention every quote source reports against. The longer ranges measure from their first point (their window opens on a day whose first point already is that day's close). Which ranges are which lives in `PRIOR_CLOSE_BASELINE_RANGES`.

This was briefly a user preference (migration 152, dropped by 153); it was removed because the prior close is the right answer rather than a taste. `usesPriorCloseBaseline` takes the range and nothing else -- if you find yourself adding a second argument, first ask whether the alternative is actually defensible.

Both halves come from **one hook**, `hooks/usePortfolioChangeBaseline.ts` (`usesPriorClose` and the `priorClose` together); the arithmetic and range set live once in `components/investments/portfolio-change-baseline.ts`. Deciding *whether* a prior close applies in one place and reading the close in another is the specific bug the single hook prevents. The baseline is looked up for the **first point on screen**, never the requested window start (on a weekend the 1D chart shows the last session). A baseline that has not loaded makes the change **unknown** -- both cards read N/A, never the first-point change.

### The window a price chart requests is not the period its range names

`resolveRangePreset` answers "what period is the user asking about", and ten reports depend on that answer. A *price* chart asks a narrower question -- **which close is the series measured from** -- so it has its own function: `components/investments/portfolio-range-window.ts` holds the table (`PORTFOLIO_WINDOW_STARTS`), and the Portfolio Value report, the Investments chart and the dashboard widget resolve through `usePortfolioRangeWindow`. Do not reach for `resolveRangePreset` in a fourth portfolio surface, and do not "fix" a range by editing the shared resolver.

The rules are not uniform -- each matches the platform being compared against:

- **3M, 6M, 1Y, 2Y, 5Y** open on the calendar day *before* the period (2Y follows the calendar, not a 730-day count).
- **YTD** opens on the year's first *trading* day (`netWorthApi.getFirstPricedDay` answers from `security_prices`). A null answer keeps the calendar boundary rather than claiming a trading day nobody observed.
- **1M** keeps its window and collapses its first *day* to that day's close (`trimIntradayToFirstDayClose`) -- it is an intraday chart, and opening mid-session a month ago mixes a mid-session price into a series of closes. 1D deliberately opens at the open; 1W and MTD are measured from the prior close already.

Both intraday adjustments live inside `trimIntradayPoints`, which every intraday render site calls -- a shaping step applied at three of four call sites is a chart that disagrees with itself.

**A range served monthly cannot honour a day-precision rule.** 2Y and 5Y use month buckets, so their first point is a month-end close. Switch the range to daily if the exact opening close matters; do not prepend a single daily point to a monthly series (the sampling splice `docs/time-series-contract.md` section 1.2 exists to stop).

`mtd` is a chart range with no backend series of its own: it rides on the rolling 1M series and is trimmed client-side. Both halves go through `portfolio-chart-utils.tsx` -- `intradayRangeParam` before every intraday request, `trimIntradayPoints` on every response, including the sessionStorage-cached one and the per-security breakdown. Sending `mtd` verbatim is a 400 from `IntradayValueQueryDto`'s enum; a response used untrimmed puts last month's bars in a month-to-date chart. A guard test asserts every member of `INTRADAY_RANGES` maps onto a range the endpoint accepts.

### A loan's payment, payoff and remaining interest are decided once -- `deriveLoanFigures`

Three figures appear on every amortizing-debt surface (the loan detail page's summary cards, the transactions Details sidebar), and each has a state that is neither a number nor "unknown":

- A **settled** debt owes nothing: remaining interest is a known **zero** and the payoff is "Paid off" -- not `null`. Settled means *nothing outstanding* (`-balance <= 0.01`), so an overpaid loan in credit is settled too (`Math.abs` read that credit as debt).
- A projection that hits its horizon without paying off (`paidOff` false) has no payoff date, and its accumulated interest is a subtotal -- both figures are unknown; printing the horizon's number under "Est. Remaining Interest" is a total's label over a partial sum.

`lib/loan-figures.ts` makes the decision once and both surfaces render its output. The data comes from `hooks/useLoanProjection.ts` or a `baseline` the caller already has -- never a second copy of the branching. A failed history load is `status: 'error'` with every figure unknown, never an empty history (which would project a plausible payoff from no payments at all).

### An unknown value must not render as a measured zero

The server sends `null` rather than `0` for anything it could not work out (`docs/financial-calculation-contract.md`), and the last hundred pixels are where that gets thrown away:

- **`connectNulls` on a line chart** draws a measured-looking segment through the gap. Default to `connectNulls={false}`.
- **A bar, gauge or meter at zero width** beside an "unknown" label reads as a measured zero. Draw a distinct no-data treatment, or nothing.
- **A row that disappears** when its value is `null` conflates "not applicable" with "could not be computed" -- where the payload can tell them apart, render the row with an unknown marker.
- **`?? 0`, `|| 0`, `?? 1` on an API value** is the same mistake in arithmetic form. Guard with an `isKnown()`-style check first.

Whoever adds the `null` on the server owns how it looks; a component test asserting the gap, marker or absent fill is what keeps it.

**A missing exchange rate is the same class.** `useExchangeRates().convert` / `convertToDefault` / `convertWithRateMap` return `number | null`; they previously returned the amount *unconverted*, so a 100.00 USD balance with no rate was formatted as "100.00 EUR" and summed into Net Worth. Pick the treatment from what the figure is:

- **An aggregate** uses `sumConverted` / `combineTotals` (`lib/currency-total.ts`), which keep the subtotal and the missing currencies together, rendered through `PartialTotal`. Incompleteness is a union: net worth built from a complete asset total and a partial liability total is partial.
- **A single displayed value** shows an unknown marker, or nothing. Never the unconverted number beside the target currency's symbol.
- **A chart series** uses `null` and `connectNulls={false}`; a bar, slice or gauge cannot say "unknown", so an unconvertible component leaves the chart.
- **A cumulative series** (a running balance, a forecast) is withheld whole: one missing rate invalidates every point after it, so `buildForecast` returns no points and names the currencies; `buildMultiAccountForecast` withholds every line and the total together.
- **A summary over a series** (`computeBalanceSummary`) refuses when any point is unknown -- "minimum" and "goes negative" are claims about all of it.

Same currency is 1:1 *by definition* and stays a known conversion -- keep it distinguishable from the missing case, and keep a real zero rendering as a number.

## `accountsApi.getAll()` is not "the user's accounts"

In own context the endpoint returns a **union**: accounts the caller owns, plus accounts another owner shared with them jointly, told apart by `account.isJoint` (true means the row belongs to someone else; `ownerLabel` names the owner). Any screen treating the list as "mine" is wrong for whichever half it forgot.

Filter to `!a.isJoint` before offering an account as something to **give away, delegate, or otherwise re-share** -- a delegate must not pass on the access they were given. The Edit Access modal (`components/settings/DelegateAccessModal.tsx`) derives `grantableAccounts` and uses it for the grouping, the empty state, the baseline diff and the save payload -- not just the rows it draws. The server refuses a non-owned account too (`setGrants` -> 403), so every toggle on an unfiltered list is one whose save cannot succeed. The converse is not true: an account the caller owns and has shared *out* carries `jointGranteeCount` and stays assignable.

### On a joint row, *every* picker reads the owner's list -- and creation is off

A joint row may only carry the owner's reference ids, so `TransactionForm` derives `effectiveCategories` / `effectivePayees` from the grant-gated reference-data endpoint, and **everything** downstream reads those, not the caller's own `categories`: the option list, the income/expense sign lookups, and the split editor (three sites still read `categories` and each failed quietly -- a pick in `SplitEditor` wrote one of the caller's ids onto the owner's row). Split mode being blocked on the *mode button* is not the same as unreachable: opening a split row that already lives there puts the form straight into it.

Creation gets a blunter answer: **do not offer it.** `categoriesApi.create` writes to the caller's ledger, so "+ Create" on a joint account made the category in the wrong place. Until an owner-scoped create exists, withhold the creator (`jointSafeCategoryCreator`) rather than gate the button on a `categoriesCanCreate` flag the code cannot honour -- withholding is also what makes the rule hold everywhere at once, since the Category field, the transfer form's, and every split line take the same optional prop.

## Form Patterns

`useFormModal<T>` (`hooks/useFormModal.ts`) manages create/edit modal state with browser-history integration (back button closes), unsaved-changes detection via `UnsavedChangesDialog`, and form submit exposed via ref. Returns `showForm`, `editingItem`, `openCreate()`, `openEdit(item)`, `close()`, `modalProps`, `unsavedChangesDialog`.

Supporting hooks: `useFormSubmitRef` (expose submit via ref), `useFormDirtyNotify` (track dirty state). Forms use react-hook-form + Zod.

## Internationalization (i18n)

All user-facing strings go through `next-intl` -- no hardcoded literals. Read them with `useTranslations('namespace')`; catalogs live in `src/i18n/messages/{locale}/{namespace}.json` (locales `de`, `en`, `en-US`, `en-CA`, `en-GB`, `es`, `fr`, `hi`, `id`, `it`, `ja`, `ko`, `nl`, `pl`, `pt`, `pt-BR`, `ru`, `tr`, `uk`, `vi`, `zh-CN`, `zh-TW`, `xx`; the `en-*` locales are lean regional variants holding only the strings that differ from `en`; register new namespaces in `src/i18n/messages.ts`). Use `t.rich` for embedded markup and `t.raw` for template strings. Adding or changing a string means updating every locale (`src/i18n/messages.parity.test.ts` fails otherwise), then `npm run i18n:pseudo`. The language is a user preference (`LanguageSelector` in Settings -> Preferences). Full contributor flow: `src/i18n/messages/README.md`.

## React Testing (act() Pattern)

Components with async `useEffect` (API calls on mount) MUST use this pattern to avoid act() warnings:

```typescript
async function renderMyComponent() {
  let result: ReturnType<typeof render>;
  await act(async () => {
    result = render(<MyComponent />);
  });
  return result!;
}

it('renders data', async () => {
  const { getByText } = await renderMyComponent();
  expect(getByText('Expected')).toBeInTheDocument();
});
```

Wrap user interactions that trigger async state updates: `await act(async () => { fireEvent.click(button); });`

When a mock rejects a Promise, the component's error handler runs in a subsequent microtask after `act()` resolves. Add a flush after the interaction to drain it:

```typescript
await act(async () => { fireEvent.click(runBtn); });
await act(async () => {}); // flush pending rejection handlers
await waitFor(() => expect(screen.getByText('Error message')).toBeInTheDocument());
```

Never use synchronous `act(() => {...})` for calls that trigger async side-effects — always `await act(async () => {...})`.

**`vitest run` does not show you the warnings.** The default reporter buffers console output and prints it only for failing tests. Use `npx vitest run --reporter=verbose` and grep for `not wrapped in act`.

**A store reset in a file's `afterEach` runs while the tree is still mounted.** Testing Library registers its `cleanup` at import time and vitest runs after-hooks in reverse registration order, so the file's own hook goes first, and a Zustand write there re-renders the mounted component outside act. Call `cleanup()` at the top of the hook. `src/test/test-hygiene.test.ts` scans for it.

**Three quieter sources of the same warning:**

- A **synchronous `render(...)` of a component that fetches on mount** -- even in a test that only asserts static copy, and even with a stubbed `mockResolvedValue([])`. Give the file one `await act(async () => { render(...) })` helper and use it everywhere.
- An **awaited handler behind a click**: `fireEvent.click` is act-wrapped, but the `finally { setBusy(false) }` after an `await` lands in a later microtask. Wrap the click in `await act(async () => ...)`.
- A **bare `await new Promise(r => setTimeout(r, n))`** used to let a `requestAnimationFrame` run -- put the wait inside `await act(async () => { ... })`.

**A mocked hook must return a stable object if the real one does.** `useRouter()` returns the same router every render; a mock written as `useRouter: () => ({ push: vi.fn(), ... })` returns a new one per call, so every `useCallback([router])` changes identity each render and an effect that also sets state loops forever (the Transactions page made 83 `getAll` calls in 300ms under its own local mock). The mock in `src/test/setup.ts` builds one router for the run; a file overriding it to observe `push` must do the same (build it lazily inside the factory -- `vi.mock` is hoisted above the `const mockPush` it closes over). Applies to any mocked hook returning an object or array.

## Testing Conventions

**Custom render** (`test/render.tsx`): Wraps components with `ThemeProvider`. Import `render` from `@/test/render` instead of `@testing-library/react`.

**Global mocks** (`test/setup.ts`): `next/navigation` (useRouter, usePathname, useSearchParams), `react-hot-toast`, `localStorage`, `window.scrollTo`, `window.matchMedia`.

**Test file naming:** named after the component and co-located with it, e.g. `AccountForm.test.tsx` beside `AccountForm.tsx`.

## Theme

`ThemeContext` provides `theme` (light/dark/system), `resolvedTheme`, and `setTheme()`, plus `colorTheme`/`setColorTheme()` for the colour palette (`src/lib/color-themes.ts`). Both persisted to localStorage; applies `dark` class and a `data-theme` attribute (`default` = no attribute) to `<html>`; listens for system preference changes via `matchMedia`. Custom theme variables in `globals.css` `@theme` block; dark variant `@variant dark (&:where(.dark, .dark *))`.

Colour themes are pure CSS variable overrides in `src/app/themes.css` (`html[data-theme="..."]` redefines the gray/blue ramps; Tailwind v4 utilities compile to `var(--color-*)` so no component changes are needed). Chart colours go through `src/lib/chart-colors.ts`, which exposes `var(--chart-*)` strings for Recharts props; never hardcode hex colours in charts, and never theme user-chosen entity colours (tags, categories, payees).

### The boot surfaces read the theme from cookies, not from localStorage

`ThemeProvider` returns `null` until it has read localStorage, so nothing it renders can decide the first paint. The surfaces that paint before hydration -- the server-stamped `dark` class and `data-theme` attribute in `layout.tsx`, the boot splash (`components/layout/BootSplash.tsx`, hidden by `BootSplashHider` once the app mounts -- *hidden*, never removed: detaching a React-owned node outside React crashes the reconciler on the next client-side navigation), the `theme-color` viewport meta, and the PWA manifest's splash palette (`app/manifest.webmanifest/route.ts`) -- read the `monize-resolved-theme` and `monize-color-theme` cookies that `ThemeContext` mirrors on every change (`src/lib/pwa-theme.ts` owns the names and fallback colours).

A non-CSS consumer needing a palette's actual hex goes through `THEME_SWATCHES` (`src/lib/theme-swatches.ts`), never a literal; the service worker's offline fallback cannot import either, so `components/providers/OfflineFallbackSync.tsx` posts it the localized copy and computed page colours, and `src/test/sw-offline.test.ts` holds sw.js's built-in fallbacks equal to the catalog and `pwa-theme` constants. The manifest link is hand-written in `layout.tsx` with `crossorigin="use-credentials"` (a manifest fetch carries no cookies without it, which Next's static manifest convention cannot express -- hence the route handler). The link's href also encodes the theme as query parameters so a cookieless manifest update check still resolves the installed theme (cookies, when present, win); the manifest pins `id: '/'`. The OS bakes splash colours in at install time and refreshes lazily; the boot splash is the surface that follows a theme change immediately.

**A palette needs a dark block, or dark mode renders its light colours.** A theme's `html[data-theme]` block (0,1,1) beats the `.dark` defaults (0,1,0), so light-tuned values win in dark mode too. Every such theme carries an `html.dark[data-theme='x']` block (0,2,1), and `src/test/theme-contrast.test.ts` fails when one is missing or partial.

The same test holds the contrast floors -- body text, muted text, links and every chart token against their surfaces, per theme and mode, plus a minimum page/card/border separation in dark mode. Pre-existing shortfalls live in a shrink-only `KNOWN_CONTRAST_DEBT`; genuine design exceptions (midnight is black-on-black by intent) in `DELIBERATE`. Values must be literal 6-digit hex: `resolvePdfColor` accepts nothing else and silently falls back to grey. `frontend/scripts/derive-dark-palette.mjs` generates a starting point; the test, not the script, is the authority.

**The gray ramp is the theme, and it is generated.** Cards, pages, borders and most text read from the gray ramp (nearly every pixel), while the accent shows only on buttons, links and chart series -- so near-neutral ramps made themes interchangeable. The ramps come from `frontend/scripts/derive-theme-ramp.mjs`: one lightness curve shared by every theme, each theme setting hue and intensity. Consequences: contrast is a property of the curve, checked once; chroma is spent as a *share of what the hue can hold* (the gamut near white is wildly asymmetric -- a flat target tints warm themes hard and leaves cool ones untouched); hue-shifting themes concentrate the shift in the midtones.

**Intensity is not a tuning knob, it is half the identity.** Hue alone cannot separate the cream/parchment family (gruvbox vs solarized, MS Money's pale parchment); members are told apart by how strongly the paper is tinted and where the ramp's dark end goes. `theme-swatches.test.ts` therefore measures **perceptual distance** between every pair of tinted papers rather than comparing hex strings (the reported collisions differed in every byte and measured 0.0032 in OKLab); floors are set below the achievable minimum for eleven themes on one hue wheel.

Three themes are deliberately ungenerated and near-neutral: `default`, `midnight` (black AMOLED by design) and `highcontrast` (maximum luminance contrast). That policy is asserted, so the exceptions read as decisions.

**An accessibility theme is exempt from what it actually guarantees, and no more.** `colorblind`'s promise is its Okabe-Ito CHART palette, not its chrome -- leaving its greys stock made it byte-identical to `default` on every chartless screen. Its ramp is generated now; `highcontrast` stays exempt because *its* promise is about luminance, which chroma really would spend.

**Two themes that share a strategy need different jobs, not different hexes.** `highcontrast` and `midnight` were both a black page under a near-black card and read as one theme. Midnight optimises for OLED (unlit blacks, quiet borders); highcontrast for visible STRUCTURE (a panel edge you cannot locate is the accessibility failure), so its card sits well clear of its page with a bright border -- which is also why it no longer needs the `card-vs-page` exemption midnight still carries.

Changing the curve is a change to every theme at once -- expect the guard to name chart colours and accents that need re-seating, and re-seat them rather than widening the debt register.

**A theme preview is a copy of the stylesheet, and copies rot.** A browser only computes the *active* theme's custom properties, so the picker's swatches live in `src/lib/theme-swatches.ts`. `theme-swatches.test.ts` parses the CSS through the same cascade the contrast guard uses (`src/test/theme-css.ts`) and fails when a swatch disagrees with the token it claims to show, or when two themes end up with identical swatches.

**A hand-rolled CSS bar is a chart.** `chartColors` is not only for Recharts props -- a `<div>` bar, and the amount printed beside it, take the tokens through `style={{ backgroundColor }}` / `style={{ color }}`. `bg-green-400 dark:bg-green-500` stays Tailwind green on every other theme. To emphasise one bar among many, vary `opacity` on the same token rather than picking a second shade -- opacity moves toward the card in both modes.

**The tokens cover more than series colour.** `chartColors.grid` and `.axis` carry their own dark overrides (no `dark:stroke-*` needed). `chartColors.surface` is the card behind the chart -- use it for the ring around a marker dot (it must be the background, not white). `chartColors.neutral` is for unclassified data. `ui-conventions.test.ts` fails on any hex reaching a `fill`, `stroke` or `stopColor` in a component that imports recharts. Two deliberate non-targets: `summaryCards[].color` for the PDF export (`pdf-export.ts` parses hex; `var(...)` would be NaN), and colour on a *data* field, indistinguishable from the PDF case by regex. White drawn on top of a filled shape (label text in a coloured flag bubble) is contrast-on-fill and stays literal.

**Spending is not an error: default a breakdown to `chartColors.primary`, not `chartColors.expense`.** Red is loud and spent deliberately (the Monthly Totals chart, where a loss month is the point). A routine breakdown (top categories, paid-from accounts, a seasonality strip) is a magnitude comparison, so its bars take the theme accent. Keep `chartColors.income` for genuine inflows so a refund is still distinguishable. `TopGroupsPanel` and `PayeeSeasonalityPanel` are the worked examples, each with a guard test asserting no `bg-`/`text-red|green-N` and no `var(--chart-expense)` survives. `income`/`expense` remain right for a chart genuinely *about* the in/out split.

**A member series drawn beside a total takes `chartSeriesColorAsidePrimary`, not `chartSeriesColor`.** `--chart-1` is the theme accent in every palette, and so is `--chart-primary` -- so a chart drawing an aggregate line in `chartColors.primary` and starting members at palette slot 0 hands the first member the total's own colour. The helper excludes that slot from the cycle rather than deferring it (a modulo over the full palette gives it back on the tenth series). `CashFlowForecastChart` is the worked example; `chart-colors.test.ts` pins both halves. Use plain `chartSeriesColor` where there is no primary series to collide with.

## Security Notes

- **Zod:** Configured with `jitless: true` (`zodConfig.ts`) for CSP compliance -- no `new Function()`
- **Auth tokens:** Stored in httpOnly cookies (backend-managed), never in JS-accessible storage
- **localStorage is readable by any XSS, and by any scanner pointed at a public page.** A store that persists there must be listed in `src/store/persisted-storage.guard.test.ts` with the reason its contents may sit in storage, and the pre-login footprint (`auth-storage` and `monize-preferences`, both empty envelopes) is pinned there byte for byte -- the ZAP baseline's rule 120000 is silenced in `.github/zap/rules.tsv` on exactly that claim, so widening a `partialize` fails the guard rather than shipping under an IGNORE written for a smaller footprint.
- **CSP:** Per-request nonce generated in proxy, `strict-dynamic` for script-src
- **ESLint:** `no-new-func: error` enforced to prevent CSP violations
