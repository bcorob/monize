/**
 * Fail a test run on next-intl's message errors instead of printing them.
 *
 * `useTranslations` does not throw when a message is missing -- it reports the
 * error and returns the KEY. So a toast that should read "Import complete"
 * renders `common.importComplete`, the test still passes, and the only trace is
 * a line on stderr that vitest's default reporter buffers away for passing
 * tests. That is the same shape as the act warnings next door: invisible
 * locally, visible only in a CI log nobody reads.
 *
 * It went unnoticed for as long as it did because the harness looked correct.
 * `src/test/render.tsx` has always loaded EVERY English namespace from a glob,
 * so a component rendered through it resolves everything. But `renderHook` was
 * re-exported from `@testing-library/react` untouched, so hooks got no provider
 * at all -- and fourteen test files answered that by hand-rolling a
 * `NextIntlClientProvider` with a hand-picked namespace list. Every one of the
 * fourteen was partial. `useImportWizard` calls `useTranslations('import')` and
 * `useTranslations('common')`; its test supplied only `import`, so every
 * `common` lookup in that hook reported MISSING_MESSAGE.
 *
 * A hand-picked list is a snapshot of what its subject used the day it was
 * written, so it rots the moment a namespace is added -- silently, because
 * nothing fails. This guard is what makes the rot loud: wired as the provider's
 * `onError` in `render.tsx` and as a `console.error` filter in `setup.ts`, so
 * an error is caught whether or not the tree went through our provider.
 *
 * Fix the lookup, never the symptom: render through `@/test/render`, which
 * supplies every namespace and picks up new ones with no file to edit. Adding a
 * code to the ignore list below only restores the silence this exists to
 * remove.
 */

/**
 * The codes that mean a test is reading a string the user would never see.
 *
 * Deliberately not `ENVIRONMENT_FALLBACK`: next-intl reports that when no
 * explicit time zone is configured, which is a property of the harness rather
 * than of the test, fires identically for every test in the run, and names
 * nothing a test author can act on. Failing on it would make the whole suite
 * red for a reason no individual test can fix -- the same trap the act guard
 * documents for React's "testing environment is not configured" line.
 */
const FAILING_CODES = new Set([
  'MISSING_MESSAGE',
  'INSUFFICIENT_PATH',
  'INVALID_MESSAGE',
  'INVALID_KEY',
  'FORMATTING_ERROR',
]);

const errors: string[] = [];

/** next-intl's IntlError shape, as much of it as the classifier needs. */
function intlErrorCode(value: unknown): string | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const code = (value as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

/**
 * Record one candidate error if it is an actionable next-intl error, and report
 * whether it was recorded so the caller can swallow it.
 *
 * Classifying and recording are one function on purpose -- `act-guard.ts` has
 * the story of what happens when they are two and disagree.
 *
 * Takes `unknown` because it is fed from two places with different shapes: the
 * provider's `onError` hands over an `IntlError` instance, while `console.error`
 * hands over whatever next-intl's default handler printed.
 */
export function recordIfIntlError(value: unknown): boolean {
  const code = intlErrorCode(value);
  if (!code || !FAILING_CODES.has(code)) return false;
  const message = (value as { message?: unknown }).message;
  errors.push(typeof message === 'string' && message ? message : code);
  return true;
}

/** Test-only: what has been recorded and not yet reported. */
export function pendingIntlErrors(): readonly string[] {
  return [...errors];
}

/** Throw if anything was recorded since the last call, and reset. */
export function failOnIntlErrors(): void {
  if (errors.length === 0) return;
  const seen = [...new Set(errors)];
  errors.length = 0;
  throw new Error(
    `next-intl reported ${
      seen.length === 1 ? 'a message error' : `${seen.length} message errors`
    } during this test. The lookup returned the KEY rather than the string a ` +
      'user would see, so any assertion on that text was checking a broken ' +
      'string.\n\nRender through `@/test/render` (its provider carries every ' +
      `English namespace) rather than a hand-built message set.\n\n${seen.join('\n\n')}`,
  );
}
