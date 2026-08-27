import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  FALLBACK_DEFAULT_CURRENCY,
  preferredCurrency,
} from './default-currency';

/**
 * One question -- "what currency do I report this reader's totals in when they
 * have stated no preference" -- asked on both sides of the wire, so one answer.
 *
 * There were fourteen copies of it: ten in `frontend/src` (six USD, four CAD)
 * and four in `backend/src` (two of them CAD). Two dashboard widgets on ONE
 * screen disagreed, and a preference-less user's bills page converted and
 * labelled in CAD while the assistant answered the same question in USD.
 *
 * A per-file read is correct on its own and wrong against its siblings, which is
 * why the check has to span them.
 */
const frontendRoot = join(__dirname, '..');
const repoRoot = join(__dirname, '..', '..', '..');

/** Every `.ts`/`.tsx` under `src/`, tests excluded. */
function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      sourceFiles(full, out);
      continue;
    }
    if (!/\.tsx?$/.test(entry)) continue;
    if (/\.(test|spec)\.tsx?$/.test(entry)) continue;
    if (full.endsWith(join('lib', 'default-currency.ts'))) continue;
    out.push(full);
  }
  return out;
}

/**
 * A hand-rolled fallback: a `defaultCurrency` read followed by `||`/`??` onto a
 * quoted three-letter code. By shape rather than by the exact `'CAD'`, so a
 * copy with a different fallback fails too -- two surfaces reporting in two
 * currencies is the same defect, louder.
 */
const HAND_ROLLED = /defaultCurrency\s*\)?\s*(?:\|\||\?\?)\s*['"][A-Za-z]{3}['"]/;

describe('the reporting-currency fallback', () => {
  it('is written once on the client', () => {
    const offenders = sourceFiles(frontendRoot)
      .filter((file) => HAND_ROLLED.test(readFileSync(file, 'utf8')))
      .map((file) => file.slice(frontendRoot.length + 1));
    expect(offenders).toEqual([]);
  });

  it('matches the currency the server falls back to', () => {
    // The two appear side by side -- a converted total on a page beside the same
    // total from the assistant -- so disagreeing means one screen silently
    // reports another currency's number.
    const backend = readFileSync(
      join(repoRoot, 'backend/src/common/default-currency.util.ts'),
      'utf8',
    );
    const declared = backend.match(
      /export const FALLBACK_DEFAULT_CURRENCY = "([A-Z]{3})";/,
    );
    expect(declared).not.toBeNull();
    expect(declared![1]).toBe(FALLBACK_DEFAULT_CURRENCY);
  });

  it('has no aliased second copy', () => {
    // A constant declared elsewhere with the same value is the copy a shape scan
    // cannot see: `locale-currency.ts` held `FALLBACK_CURRENCY = "USD"` with a
    // comment claiming it matched the backend's default -- a claim about another
    // file that nothing checked. Derive from this module instead.
    const aliased = sourceFiles(frontendRoot)
      .filter((file) =>
        /const\s+[A-Z_]*CURRENCY[A-Z_]*(?::\s*string)?\s*=\s*['"][A-Za-z]{3}['"]/.test(
          readFileSync(file, 'utf8'),
        ),
      )
      .map((file) => file.slice(frontendRoot.length + 1));
    expect(aliased).toEqual([]);
  });

  it('reads a cleared preference as absent, not as a currency', () => {
    expect(preferredCurrency('')).toBe(FALLBACK_DEFAULT_CURRENCY);
    expect(preferredCurrency(null)).toBe(FALLBACK_DEFAULT_CURRENCY);
    expect(preferredCurrency(undefined)).toBe(FALLBACK_DEFAULT_CURRENCY);
    expect(preferredCurrency('EUR')).toBe('EUR');
  });
});
