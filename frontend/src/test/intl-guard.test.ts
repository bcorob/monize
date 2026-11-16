import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { failOnIntlErrors, pendingIntlErrors, recordIfIntlError } from './intl-guard';

/** next-intl's IntlError carries `code` and `message`; that is all we classify on. */
function intlError(code: string, message = `${code}: something`) {
  return Object.assign(new Error(message), { code });
}

describe('intl-guard', () => {
  beforeEach(() => {
    // Drain anything a previous case recorded, so each starts clean.
    try {
      failOnIntlErrors();
    } catch {
      /* expected when the previous case recorded something */
    }
  });

  it('records an actionable message error and reports that it did', () => {
    expect(recordIfIntlError(intlError('MISSING_MESSAGE'))).toBe(true);
    expect(pendingIntlErrors()).toHaveLength(1);
    expect(() => failOnIntlErrors()).toThrow(/MISSING_MESSAGE/);
  });

  it('is not vacuous -- it ignores things that are not intl errors', () => {
    expect(recordIfIntlError('a plain string')).toBe(false);
    expect(recordIfIntlError(new Error('no code'))).toBe(false);
    expect(recordIfIntlError(undefined)).toBe(false);
    expect(recordIfIntlError(null)).toBe(false);
    expect(recordIfIntlError({ code: 42 })).toBe(false);
    expect(pendingIntlErrors()).toHaveLength(0);
    expect(() => failOnIntlErrors()).not.toThrow();
  });

  it('ignores ENVIRONMENT_FALLBACK', () => {
    // A property of the harness, identical for every test in the run and
    // actionable by none of them. See the comment in intl-guard.ts.
    expect(recordIfIntlError(intlError('ENVIRONMENT_FALLBACK'))).toBe(false);
    expect(() => failOnIntlErrors()).not.toThrow();
  });

  it('reports the failing message text, so the key is findable', () => {
    recordIfIntlError(
      intlError(
        'MISSING_MESSAGE',
        'MISSING_MESSAGE: Could not resolve `common` in messages for locale `en`.',
      ),
    );
    expect(() => failOnIntlErrors()).toThrow(/Could not resolve `common`/);
  });

  it('collapses duplicates and counts distinct ones', () => {
    recordIfIntlError(intlError('MISSING_MESSAGE', 'MISSING_MESSAGE: a'));
    recordIfIntlError(intlError('MISSING_MESSAGE', 'MISSING_MESSAGE: a'));
    recordIfIntlError(intlError('INVALID_KEY', 'INVALID_KEY: b'));
    expect(() => failOnIntlErrors()).toThrow(/2 message errors/);
  });

  it('resets after reporting, so one test does not fail the next', () => {
    recordIfIntlError(intlError('MISSING_MESSAGE'));
    expect(() => failOnIntlErrors()).toThrow();
    expect(pendingIntlErrors()).toHaveLength(0);
    expect(() => failOnIntlErrors()).not.toThrow();
  });

  // A guard nothing calls is not a guard, and this one has two doors: the
  // provider's onError (for trees rendered through `@/test/render`) and the
  // console.error filter (for everything else). Both are checked by reading.
  describe('wiring', () => {
    const setup = readFileSync(join(__dirname, 'setup.ts'), 'utf8');
    const render = readFileSync(join(__dirname, 'render.tsx'), 'utf8');

    it('routes the shared provider onError through the guard', () => {
      expect(render).toMatch(/onError=\{recordIfIntlError\}/);
    });

    it('routes console.error through the guard', () => {
      expect(setup).toMatch(/recordIfIntlError/);
    });

    it('fails after every test and after the last one', () => {
      expect(setup).toMatch(/cleanup\(\);[\s\S]*?failOnIntlErrors\(\);[\s\S]*?\}\);/);
      expect(setup).toMatch(/afterAll\(\(\) => \{[\s\S]*?failOnIntlErrors\(\);[\s\S]*?\}\)/);
    });

    it('does not suppress intl errors anywhere else', () => {
      // A second mention inside a console filter would be a silencer.
      const filtered = setup.match(/msg\.includes\('([^']*)'\)/g) ?? [];
      expect(filtered.some((m) => /intl|MISSING_MESSAGE/i.test(m))).toBe(false);
    });
  });
});
