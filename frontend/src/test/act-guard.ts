/**
 * Fail a test run on React's act() warnings instead of printing them.
 *
 * An act warning is a test reading a tree React has not finished updating: the
 * assertion sees whatever happened to be committed when it ran, so the test
 * passes or fails on timing rather than on behaviour. They are invisible on a
 * fast machine -- the late update lands inside the act scope and nothing is
 * printed -- and surface on a loaded CI runner, which is the one place nobody
 * is watching stderr. CI run #2873 carried fifteen of them under a green tick.
 *
 * Fix the update, never the symptom: await the thing that lands late
 * (`await screen.findBy...`, `await waitFor(...)`), or wrap the trigger in
 * `await act(async () => { ... })`. Filtering the message back out would only
 * restore the silence this exists to remove.
 *
 * Wired in `setup.ts`; `act-guard.test.ts` checks both this behaviour and that
 * the wiring is still there.
 */

/**
 * Only the actionable warning, and deliberately not React's other act-related
 * message -- "The current testing environment is not configured to support
 * act(...)". Matching that one turned `main` red on CI run #2875, on a test
 * nothing had changed.
 *
 * It is a different condition, and not one a test author can act on: React logs
 * it when an update is checked while `IS_REACT_ACT_ENVIRONMENT` is unset, which
 * happens during teardown after RTL has already restored the flag. It names no
 * component, so it points at nothing, and it depends on timing the suite does
 * not control -- it appeared on neither the PR run nor three full local runs of
 * the same commit. Failing on it makes the suite flaky, which is the very thing
 * this guard exists to prevent.
 */
const ACT_WARNING = /not wrapped in act/;

const warnings: string[] = [];

/**
 * Record one `console.error` call if it is React's act warning, and report
 * whether it was recorded so the caller can swallow it.
 *
 * Classifying and recording are one function on purpose. They were two, and the
 * pair disagreed: the classifier rejected a message the recorder stored anyway,
 * so a warning nothing recognised could still fail a test.
 *
 * React formats these printf-style ("An update to %s ..."), so the component
 * name arrives as a separate argument -- interpolate it, or the report names no
 * component at all.
 */
export function recordIfActWarning(args: readonly unknown[]): boolean {
  const template = typeof args[0] === 'string' ? args[0] : '';
  if (!ACT_WARNING.test(template)) return false;
  let i = 1;
  const formatted = template.replace(/%[sdifoOc]/g, () => String(args[i++] ?? ''));
  warnings.push(formatted.split('\n')[0].trim());
  return true;
}

/** Test-only: what has been recorded and not yet reported. */
export function pendingActWarnings(): readonly string[] {
  return [...warnings];
}

/** Throw if anything was recorded since the last call, and reset. */
export function failOnActWarnings(): void {
  if (warnings.length === 0) return;
  const seen = [...new Set(warnings)];
  warnings.length = 0;
  throw new Error(
    `React logged ${seen.length === 1 ? 'an act() warning' : `${seen.length} act() warnings`} ` +
      'during this test. An update landed outside act(), so the assertions ran against a tree ' +
      `React had not finished updating.\n\n${seen.join('\n\n')}`,
  );
}
