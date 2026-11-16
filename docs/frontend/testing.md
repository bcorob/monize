# Frontend: testing conventions

The Vitest harness, act() discipline, mocks, storage isolation, and what a green run does and does not prove. Read this before writing or changing a test, a mock or a test helper.

Paths beginning with `src/` or `scripts/`, and layer configuration filenames, are relative to `frontend/`; other source paths (including `test/...`) are relative to `frontend/src/`. Explicit repository prefixes are preserved. `frontend/CLAUDE.md` is the short index; this document is where the reasoning lives.

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
- **Moving a `setState` out of an effect and into a data hook changes WHEN it lands, so a passing synchronous-`render` test can start failing on a component whose fetching nobody changed.** `LoanAmortizationReport` already fetched on mount, and its "shows loading state initially" test was safe for a reason that had nothing to do with that: the loader's *no-selection* branch called `setTransactions([])` synchronously inside the effect, so it committed inside `render`. Routing the same branch through `useReportData` made it resolve a promise instead, and the update moved to a microtask after the test body. The trigger for this guard is not "does the component fetch" but **"can any branch of its loaders resolve through a promise"** -- including the early-return branch that fetches nothing.
- An **awaited handler behind a click**: `fireEvent.click` is act-wrapped, but the `finally { setBusy(false) }` after an `await` lands in a later microtask. Wrap the click in `await act(async () => ...)`.
- A **bare `await new Promise(r => setTimeout(r, n))`** used to let a `requestAnimationFrame` run -- put the wait inside `await act(async () => { ... })`.

**A fixture that means "the reader's own currency" says so through the constant, not by spelling a code.** Four test files pinned behaviour against a reader on CAD -- one by hardcoding the conversion target inside its own `useExchangeRates` mock, one by giving the security `currencyCode: 'USD'` to mean *foreign*, one by setting `defaultCurrency` in a `usePreferencesStore` mock that ignored its selector (so the value never reached the component and every case silently ran on the fallback). All four passed for as long as the fallback happened to be CAD, and when it moved to USD they failed with the components correct: the fixtures had been asserting the opposite of their own names. Derive from `FALLBACK_DEFAULT_CURRENCY` (`lib/default-currency.ts`) where a case is about the reader's own currency, and pick a code that can never be the fallback where it is about a foreign one.

**A mocked selector hook applies the selector.** `usePreferencesStore: () => ({ preferences: {...} })` returns the whole state whatever it is asked for, so `usePreferencesStore((s) => s.preferences)` gets one level too deep and every read off it is `undefined` -- the component takes its no-preferences branch while the fixture claims to have set one. `src/test/test-hygiene.test.ts` scans for a zero-argument mock of any selector store.

**A mocked hook must return a stable object if the real one does.** `useRouter()` returns the same router every render; a mock written as `useRouter: () => ({ push: vi.fn(), ... })` returns a new one per call, so every `useCallback([router])` changes identity each render and an effect that also sets state loops forever (the Transactions page made 83 `getAll` calls in 300ms under its own local mock). The mock in `src/test/setup.ts` builds one router for the run; a file overriding it to observe `push` must do the same (build it lazily inside the factory -- `vi.mock` is hoisted above the `const mockPush` it closes over). Applies to any mocked hook returning an object or array.

## Testing Conventions

**Custom render** (`test/render.tsx`): Wraps components with `ThemeProvider` and a `NextIntlClientProvider` carrying every English namespace. Import `render` **and `renderHook`** from `@/test/render`, never from `@testing-library/react`.

## A missing message is a failure, and the harness is what supplies them

`useTranslations` does not throw on a missing message -- it reports the error and returns the KEY, so a toast renders `common.importComplete` instead of "Import complete" while the test passes. Vitest's default reporter buffers that stderr line away for passing tests, so it is visible only in a CI log.

The harness looked correct throughout: `render.tsx` has always loaded every English namespace from an `import.meta.glob`. But it wrapped only `render`, and its `export * from '@testing-library/react'` re-exported `renderHook` **untouched** -- so a hook test had no way to get a provider except to build one, and fourteen files did, each with a hand-picked namespace list, every one of them partial. `useImportWizard` reads `import` and `common`; its test supplied `import` alone. A hand-picked list is a snapshot of what its subject used the day it was written, and nothing fails when it rots.

So: **`renderHook` is exported from `@/test/render` too**, wrapped in the same providers, and both compose a caller's own `wrapper` *inside* them rather than replacing them (a test needing StrictMode no longer has to give up intl to get it). A nested provider is worse than it looks -- it SHADOWS the full message set for everything below it, so adding one narrows the catalogue rather than widening it.

`src/test/intl-guard.ts` turns any `MISSING_MESSAGE` / `INVALID_MESSAGE` / `INVALID_KEY` / `INSUFFICIENT_PATH` / `FORMATTING_ERROR` into a test failure, wired both as the shared provider's `onError` and as a `console.error` filter in `setup.ts` -- two doors, so a tree rendered outside the harness is still caught. `ENVIRONMENT_FALLBACK` is deliberately excluded: it is a property of the harness, fires identically for every test, and names nothing an author can act on (the same reasoning as the act guard's second React message).

`intl-harness.guard.test.ts` scans for the two ways round it: `render`/`renderHook` imported from `@testing-library/react`, and a `NextIntlClientProvider` built in a test. Its `ALLOWED_*` sets are deliberate exceptions -- tests that genuinely vary the locale, and the boot-path components defined by having no providers -- while `RTL_IMPORT_BASELINE` is shrink-only: 45 older tests that work today only because their subjects happen not to translate anything. Converting one means deleting its line.

Fix the lookup, never the symptom. Adding a code to the ignore list only restores the silence the guard exists to remove.

**A `useNumberFormat` mock spreads `numberFormatMockDefaults()`.** That hook is
mocked in ~127 files, each with a bare factory listing the formatters its
component used the day the test was written -- and a bare factory REPLACES the
module, so the literal is the hook's whole surface for that file. Nothing failed
while those lists rotted; adding a `formatPercent` call to a component turned
thirty-nine unrelated suites red with "formatPercent is not a function", not one
of which was a real defect. Spread `numberFormatMockDefaults()`
(`@/test/number-format-mock`) first and override only what the case asserts on.
The factory has to be `async` so it can `await import` the helper past
`vi.mock`'s hoisting. The defaults are functions only: `defaultCurrency`,
`numberFormat` and `numberLocale` are identity-bearing values a case states for
itself, and defaulting them would change what an existing assertion is about,
while a missing function can only ever have been a crash.

**Global mocks** (`test/setup.ts`): `next/navigation` (useRouter, usePathname, useSearchParams), `react-hot-toast`, `localStorage`, `window.scrollTo`, `window.matchMedia`.

**Test file naming:** named after the component and co-located with it, e.g. `AccountForm.test.tsx` beside `AccountForm.tsx`.

**A `vi.mock` factory replaces the whole module, so mock a module you only partly want with `importOriginal`.** A factory listing the one api object it needs turns every *other* export of that module into `undefined`, for the entire module graph under test -- and the failure is nowhere near the mock. Two shapes of it happened on the same module in one PR: a gating predicate became "not a function" and silently stopped gating, and a constant another module derives a `Set` from threw at import. Spread the original and override what you are faking:

```ts
vi.mock('@/lib/loan-rate-changes', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/loan-rate-changes')>()),
  loanRateChangesApi: { getAll: (...args: unknown[]) => getRateChanges(...args) },
}));
```

The bare-factory form is only right when you mean to blank the module. Where a module's non-api exports are load-bearing in production code, pin the rule with a scan rather than prose -- `lib/loan-rate-changes.contract.test.ts` fails on a factory mock of that module anywhere in the tree.

## An act() warning is a failure, not a log line

A test asserting on a tree React has not finished updating reads whatever
happened to be committed when the assertion ran -- it passes or fails on
timing, not on behaviour. React says so, on stderr, and nobody is watching
stderr in a 14,000-test run: CI run #2873 carried fifteen act warnings under a
green tick, in the same job whose one real failure was a race. So `src/test/setup.ts`
routes them into `src/test/act-guard.ts`, which **fails** the test that earned
them. `act-guard.test.ts` checks the behaviour and scans `setup.ts` for the
wiring, because a guard nothing calls is not a guard.

Fix the update, never the message. In order of preference: await the thing that
lands late (`await screen.findBy...`, `await waitFor(...)`); or wrap the trigger
in `await act(async () => { ... })`. Adding the text to a console filter is the
one response that is always wrong.

**Exactly one message is that failure**: `An update to <Component> inside a test
was not wrapped in act(...)`. React's other act-related line -- `The current
testing environment is not configured to support act(...)` -- is a different
condition and is deliberately *not* failed on. It fires when an update is
checked while `IS_REACT_ACT_ENVIRONMENT` is unset, which happens during teardown
after RTL has restored the flag; it names no component, so it points at nothing,
and it depends on timing the suite does not control. Matching it turned `main`
red on CI run #2875, on a test nothing had changed and that neither the PR run
nor three full local runs of the same commit had flagged. **A guard against
flakiness that is itself timing-dependent is worse than none.**

And a guard classifies in one place: `recordIfActWarning` both recognises and
records, because the two were separate functions that disagreed -- the
classifier rejected a message the recorder stored anyway, so a warning nothing
recognised could still fail a test.

Three sources produce nearly all of them here:

- **A synchronous test with a request still in flight.** The response commits
  after the test returns, into whichever tree is mounted by then. Settle it
  before returning, even when the assertion is about the state *before* it
  arrives (`useStaleReconciliation.test.ts`).
- **`vi.waitFor` and `element.dispatchEvent`, which are not act-aware.** Prefer
  RTL's `waitFor` and `fireEvent`; `fireEvent(element, event)` takes an event
  object when a test needs to spy on that exact one. Where Vitest's fake timers
  rule out RTL's `waitFor` -- it cannot drive them -- drain the clock inside
  act: `await act(async () => { await vi.advanceTimersByTimeAsync(n); })`.
- **A store write with the tree mounted.** Zustand notifies subscribers
  synchronously, so `useDensityStore.setState(...)` re-renders outside act
  unless wrapped. Writing *before* the render does not need it.

## Awaiting static chrome synchronises nothing

`await screen.findByText('Portfolio Value Over Time')` resolves on the page's
title -- markup that renders before any request does. Every assertion keyed off
it is asserting on an async call it never waited for. Wait for the thing being
asserted (`await waitFor(() => expect(api.x).toHaveBeenCalledTimes(1))`), which
cannot mask a real failure: a call that never happens still times out.

The trap is worst where a call is **second-stage** -- issued only after an
earlier response commits. The Portfolio Value chart's prior-close baseline is
gated on `chartPoints[0]`, so it cannot fire until the intraday response lands;
tests asserting it right after the title passed on a fast machine and failed on
CI run #2877. Before asserting that a request was made, ask what has to resolve
first.

Two exceptions, both real: an assertion already inside a `waitFor` callback, and
one inside a pinned clock -- RTL's `waitFor` cannot drive Vitest's fake timers
and will hang until the test times out, so there the act-wrapped drain is the
barrier. A blanket sweep over a file with mixed timer regimes walks into that.

## Test isolation is every storage, not just `localStorage`

`src/test/setup.ts` clears `localStorage` between tests, and for a long time
cleared nothing else. The Portfolio Value chart caches its intraday response in
`sessionStorage`, and a leaked entry hydrates the next test's chart
*synchronously on mount* -- which moves a second-stage request to immediate and
silently changes what that test is exercising. Anything a component persists is
shared state between tests: clear it, or the suite's behaviour depends on
ordering.

**A removed control has consumers `npx vitest run` never loads.** The E2E suite
lives in `e2e/`, outside `frontend/src`, so a green Vitest run says nothing about
it: deleting the Save button left `e2e/tests/settings.spec.ts` clicking a button
that no longer exists, and only CI found it. Deleting or renaming any control an
E2E spec drives means grepping `e2e/` for its accessible name in the same commit.

**An E2E alert locator is scoped to a region, never page-wide.** Next mounts its route announcer (`__next-route-announcer__`, `role="alert"`, in a shadow root under `<body>`) on every hydrated page, and Playwright's role engine matches it, so `page.getByRole('alert')` resolves to two elements the moment an error panel renders -- a strict-mode failure. The payee and category detail specs passed for months only because the poll that saw the announcer alone, before the panel, satisfied `toBeVisible`. Scope it: `page.getByRole('main').getByRole('alert')`, or a dialog. `src/test/e2e-conventions.test.ts` scans `e2e/tests` for the bare form.

**Reading Chromium's notification list destroys a notification still being displayed, so a push test never polls for one.** `registration.getNotifications()` is answered by reconciling the browser's stored notification records against what the platform reports as displayed, and a record whose display has not landed yet is *erased*, not reported "not yet" -- while `showNotification` resolves before that display lands. So a read taken straight after a push deletes the notification the test is waiting for, and the poll beside it then burns its whole timeout on something that can no longer arrive: one of the nine push tests failing per CI run, a different one each time, on branches whose diffs cannot touch push. Deliver and observe only through `e2e/push/fixture.ts`, whose `push()` waits for the worker's own `showNotification` promise, looks exactly once, and repairs an early look by delivering again (safe because `collapseTag` makes a repeat replace rather than stack). Never call `deliverPushMessage` or `getNotifications()` from a spec; `src/test/e2e-conventions.test.ts` scans `e2e/push` for both.

## Mocking one half of a `Promise.all` leaves the other half on the network

A unit test runs in jsdom, whose origin is `http://localhost:3000` -- the port the dev stack's backend listens on. Anything the code under test does not have mocked goes there for real. `authStore`'s rehydrate chain asks for the profile and the delegation context together, and `authStore.test.ts` mocked only `@/lib/auth`: the second call reached `apiClient`, the backend answered 401, and the client's 401 interceptor called `logout()` at whatever moment the round trip landed -- usually inside a later test, which then read `isAuthenticated` as false. The suite was green on a machine with nothing on that port and red on a developer's, which is the worst way for a test to be wrong.

So mock **every** client a chain touches, not the one the test is about, and assert the mock was called in at least one case so dropping it fails here rather than only on a machine running the app. A global trap that fails any test reaching XHR would catch the whole class and is worth proposing on its own; it is not a change to make while fixing one suite.
