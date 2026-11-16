import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  RATE_CHANGE_ACCOUNT_TYPES,
  supportsRateChanges,
} from './loan-rate-changes';
import { ACCOUNT_DETAIL_VIEWS } from './account-detail-views';

/**
 * Globbed rather than listed with `git ls-files`, so a brand-new caller is
 * visible to this guard before it is staged.
 */
const sources = import.meta.glob('/src/**/*.{ts,tsx}', {
  query: '?raw',
  eager: true,
  import: 'default',
}) as Record<string, string>;

/**
 * `/accounts/:id/rate-changes` answers **400** for anything but LOAN and
 * MORTGAGE, and `RATE_CHANGE_ACCOUNT_TYPES` is documented as the one place that
 * precondition is written. That is a claim about four other lists, and prose
 * cannot hold it:
 *
 *  - the backend's own constant, which decides the 400 (no import is possible
 *    across the two packages, so this parses its source);
 *  - `useLoanProjection`'s "amortizing debt" set, which fetches rate history
 *    unconditionally for every type in it;
 *  - the shared account detail-view registry, whose `loan` arm is the branch
 *    the account page fetches rate history in;
 *  - the overpayment simulator's debt-account list, whose "not revolving" gate
 *    coincides with the precondition only while the list has three members.
 *
 * The last check is the anti-rot one: it enumerates every caller of
 * `loanRateChangesApi.getAll` and fails on a fifth, so a new surface has to
 * either gate on `supportsRateChanges` or be tied here deliberately.
 */
const FRONTEND_SRC = resolve(__dirname, '..');
const REPO_ROOT = resolve(__dirname, '../../..');

function readSource(relativeToSrc: string): string {
  return readFileSync(resolve(FRONTEND_SRC, relativeToSrc), 'utf8');
}

/** Fails loudly rather than matching nothing when a guard loses its subject. */
function matchOrThrow(source: string, pattern: RegExp, what: string): string {
  const match = source.match(pattern);
  if (!match) {
    throw new Error(`${what} not found -- this guard has lost its subject`);
  }
  return match[1];
}

function parseTypeList(literal: string): string[] {
  return [...literal.matchAll(/'([A-Z_]+)'|"([A-Z_]+)"/g)]
    .map((m) => m[1] ?? m[2])
    .sort();
}

/** Compared against parsed source, so the string form is what is useful here. */
const EXPECTED: string[] = [...RATE_CHANGE_ACCOUNT_TYPES].sort();

describe('RATE_CHANGE_ACCOUNT_TYPES is the one spelling of the precondition', () => {
  it('names the types the endpoint actually accepts', () => {
    expect(EXPECTED).toEqual(['LOAN', 'MORTGAGE']);
    expect(supportsRateChanges({ accountType: 'LOAN' })).toBe(true);
    expect(supportsRateChanges({ accountType: 'LINE_OF_CREDIT' })).toBe(false);
    // Absent is not "supported by default": the reports call this with the
        // selection they have, which is `undefined` until the list resolves.
    expect(supportsRateChanges(undefined)).toBe(false);
    expect(supportsRateChanges(null)).toBe(false);
  });

  it('matches the backend constant that decides the 400', () => {
    const backend = readFileSync(
      resolve(
        REPO_ROOT,
        'backend/src/loan-rate-changes/loan-rate-changes.service.ts',
      ),
      'utf8',
    );
    const literal = matchOrThrow(
      backend,
      /const RATE_CHANGE_ACCOUNT_TYPES = \[([^\]]*)\]/,
      'backend RATE_CHANGE_ACCOUNT_TYPES',
    );
    // Spelled `AccountType.LOAN` there, so read the enum members.
    const types = [...literal.matchAll(/AccountType\.([A-Z_]+)/g)]
      .map((m) => m[1])
      .sort();
    expect(types).toEqual(EXPECTED);
  });

  it('is derived, not repeated, by the projection hook', () => {
    const source = readSource('hooks/useLoanProjection.ts');
    expect(source).toContain('new Set(\n  RATE_CHANGE_ACCOUNT_TYPES,\n)');
    // A literal account type back in that file means the derivation was undone.
    expect(source).not.toMatch(/AMORTIZING_DEBT_TYPES[\s\S]{0,200}'MORTGAGE'/);
  });

  it('matches the detail-view registry arm that fetches it', () => {
    const loanArm = Object.entries(ACCOUNT_DETAIL_VIEWS)
      .filter(([, kind]) => kind === 'loan')
      .map(([type]) => type)
      .sort();
    expect(loanArm).toEqual(EXPECTED);
    // The page fetches rate history inside `resolveAccountDetailView(...) ===
    // 'loan'` with no further gate, so that arm IS the precondition on this
    // surface. Asserting the branch too, because the registry proves the arm
    // and only the page proves it is what the fetch is gated on.
    expect(readSource('app/accounts/[id]/page.tsx')).toContain(
      "resolveAccountDetailView(accountData.accountType) !== 'loan'",
    );
  });

  it('matches the overpayment simulator, whose gate is "not revolving"', () => {
    const source = readSource(
      'components/reports/LoanOverpaymentSimulatorReport.tsx',
    );
    const debtTypes = parseTypeList(
      matchOrThrow(
        source,
        /DEBT_ACCOUNT_TYPES[^=]*=\s*\[([^\]]*)\]/,
        'simulator DEBT_ACCOUNT_TYPES',
      ),
    );
    const revolving = matchOrThrow(
      source,
      /isRevolving = selectedAccount\?\.accountType === '([A-Z_]+)'/,
      "the simulator's isRevolving comparison",
    );
    // The loader skips every fetch for the revolving type and fetches rate
    // history for all the rest, so the two must partition the list exactly.
    // A fourth debt type is a 400 on this surface until it is gated properly.
    expect(debtTypes.filter((t) => !EXPECTED.includes(t))).toEqual([revolving]);
  });

  it('is not mocked away by a bare vi.mock factory', () => {
    // A factory listing only `loanRateChangesApi` replaces every other export
    // of this module with `undefined`, and two of them are now load-bearing in
    // production code: `supportsRateChanges` (a report's gate silently becomes
    // "not a function") and `RATE_CHANGE_ACCOUNT_TYPES` (the projection hook's
    // `new Set(undefined)` throws at import). Both have happened. A mock of
    // this module must therefore spread `importOriginal`.
    const offenders = Object.entries(sources)
      .filter(([path, source]) => {
        if (!/\.(test|spec)\.tsx?$/.test(path)) return false;
        const factory = source.match(
          /vi\.mock\(\s*['"]@\/lib\/loan-rate-changes['"][\s\S]{0,400}?\n\}\)\);/,
        );
        return !!factory && !factory[0].includes('importOriginal');
      })
      .map(([path]) => path);
    expect(offenders).toEqual([]);
  });

  it('knows every caller of the rate-changes list endpoint', () => {
    // Structurally tied by the checks above rather than by an inline call to
    // `supportsRateChanges`. Not a waiver list: each entry has its own check
    // in this file, and removing one of those checks fails that check.
    const tiedByStructure = [
      '/src/app/accounts/[id]/page.tsx',
      '/src/components/reports/LoanOverpaymentSimulatorReport.tsx',
      '/src/hooks/useLoanProjection.ts',
    ];

    const callers = Object.entries(sources).filter(
      ([path, source]) =>
        !/\.(test|spec)\.tsx?$/.test(path) &&
        source.includes('loanRateChangesApi.getAll('),
    );

    expect(callers.length).toBeGreaterThan(0);
    const ungated = callers
      .filter(
        ([path, source]) =>
          !tiedByStructure.includes(path) &&
          !source.includes('supportsRateChanges'),
      )
      .map(([path]) => path);
    expect(ungated).toEqual([]);
  });
});
