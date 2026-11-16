import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

/**
 * Guards the English catalogs against a double hyphen reaching the screen.
 *
 * `--` is this repo's *code comment* style, and the convention is strong enough
 * that agents carry it straight into UI copy, where it renders literally and
 * reads as a typo. A human has had to point this out more than once, which is
 * exactly the signal that the rule needs enforcing rather than restating: see
 * "Follow the existing pattern, and pin it down when you miss it" in the root
 * CLAUDE.md.
 *
 * In copy, use an em dash, or recast the sentence. Both read correctly in every
 * locale; `--` reads correctly in none.
 *
 * Only `en` is scanned. It is the locale we author -- the others are filled in
 * one pass at acceptance -- so a failure here always names a string someone in
 * this repo just wrote, and is always actionable. A translator's punctuation is
 * their own business.
 *
 * This is a ratchet, in the shape of `backend/scripts/rls-ratchet.mjs`: the
 * baseline below may only shrink. Both directions are enforced, so cleaning a
 * string means deleting its line here, and adding one fails the build.
 */
/**
 * Read from disk rather than through `import.meta.glob`, matching the sibling
 * `messages.parity.test.ts`. The glob's typed overloads only cover the `?raw`
 * form, so globbing JSON with `import: 'default'` fails `tsc --noEmit` even
 * though Vitest runs it.
 */
const catalogs: Record<string, unknown> = (() => {
  const dir = join(dirname(fileURLToPath(import.meta.url)), 'messages', 'en');
  return Object.fromEntries(
    readdirSync(dir)
      .filter((file) => file.endsWith('.json'))
      .map((file) => [file, JSON.parse(readFileSync(join(dir, file), 'utf8'))]),
  );
})();

/**
 * Strings that already contained `--` when this guard was introduced, as
 * `namespace:key.path`. Not approved -- merely pre-existing, and worth cleaning
 * in a copy pass rather than in whatever change happens to touch the file.
 */
const BASELINE: readonly string[] = [
  'accountDetail-creditCard:payoff.neverPaysOff',
  'admin:usersPage.dialogs.deleteMessage',
  'budgets:wizardStrategy.rolloverOptions.NONE',
  'budgets:wizardStrategy.rolloverOptions.MONTHLY',
  'budgets:wizardStrategy.rolloverOptions.QUARTERLY',
  'budgets:wizardStrategy.rolloverOptions.ANNUAL',
  // Arrived on main with the Microsoft Money import (#995, #996) after this
  // guard was written, which is the behaviour it exists to stop -- listed rather
  // than rewritten because the copy is someone else's and a day old. Worth a
  // one-line clean-up pass.
  'import:mnyErrors.mnyImportFailed',
  'import:mnyPassword.retryBody',
  'import:mnyReview.fileSummary',
  'import:toasts.mnySingleFileOnly',
  'settings:about.versionMismatch',
  'settings:supportBackup.howItWorks',
  'settings:supportBackup.confirmPasswordMessage',
  'settings:supportBackup.confirmPasswordConfirm',
  'settings:emergencyAccess.message.toasts.verifyAgain',
  'settings:emergencyAccess.status.timerNote',
];

/** Every `namespace:key.path` in the English catalogs whose value holds `--`. */
function offenders(): string[] {
  const found: string[] = [];
  for (const [path, catalog] of Object.entries(catalogs)) {
    const namespace = path.split('/').pop()!.replace(/\.json$/, '');
    const walk = (value: unknown, keyPath: string): void => {
      if (typeof value === 'string') {
        if (value.includes('--')) found.push(`${namespace}:${keyPath}`);
        return;
      }
      if (value && typeof value === 'object') {
        for (const [key, child] of Object.entries(value)) {
          walk(child, keyPath ? `${keyPath}.${key}` : key);
        }
      }
    };
    walk(catalog, '');
  }
  return found.sort();
}

describe('English copy avoids the double hyphen', () => {
  it('loads the catalogs, so the scan cannot pass vacuously', () => {
    // Were the glob to stop matching, every assertion below would trivially
    // pass over an empty set.
    expect(Object.keys(catalogs).length).toBeGreaterThan(20);
  });

  it('introduces no new string containing --', () => {
    const added = offenders().filter((key) => !BASELINE.includes(key));
    // Use an em dash, or rewrite the sentence without the aside.
    expect(added).toEqual([]);
  });

  it('keeps the baseline free of strings that have since been cleaned', () => {
    // The ratchet's teeth: a cleaned string must leave this list, so the list
    // can only ever get shorter.
    const current = offenders();
    const stale = BASELINE.filter((key) => !current.includes(key));
    expect(stale).toEqual([]);
  });
});
