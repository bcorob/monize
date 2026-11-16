/**
 * A complete, deterministic stand-in for `useNumberFormat()`'s return value.
 *
 * Test files mock that hook with a bare `vi.mock` factory -- which replaces the
 * whole module, so the mock's object literal IS the hook's surface for that
 * file. Each one listed only the formatters its component used the day it was
 * written, and nothing failed when that rotted: adding a `formatPercent` call to
 * a component (issue #1316) turned thirty-nine unrelated suites red with
 * "formatPercent is not a function", none of which was a real defect.
 *
 * Spread this first and override what the test actually asserts on:
 *
 * ```ts
 * vi.mock('@/hooks/useNumberFormat', async () => {
 *   const { numberFormatMockDefaults } = await import('@/test/number-format-mock');
 *   return {
 *     useNumberFormat: () => ({
 *       ...numberFormatMockDefaults(),
 *       formatCurrency: (n: number) => `$${n.toFixed(2)}`,
 *     }),
 *   };
 * });
 * ```
 *
 * Deliberately FUNCTIONS ONLY. `defaultCurrency`, `numberFormat` and
 * `numberLocale` are identity-bearing values a case should state for itself, and
 * defaulting them would silently change what an existing assertion is about;
 * a missing function, by contrast, can only ever have been a crash.
 *
 * The renderings are en-US-shaped because that is what the mocks being replaced
 * wrote. They are not a locale claim -- locale behaviour belongs to the real
 * hook, and is tested in `src/hooks/useNumberFormat.test.ts` and in the
 * component locale cases (`SecurityList.test.tsx`).
 */

import { scaleBytes } from '@/lib/bytes';
export function numberFormatMockDefaults() {
  // Grouped through Intl, not `toFixed`: the real hook groups, so a default that
  // did not would quietly make "5,000 runs" render as "5000 runs" in any test
  // that leans on the default rather than stating its own.
  const plain = (value: number, digits = 2) =>
    new Intl.NumberFormat('en-US', {
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
    }).format(value);
  const money = (value: number, digits = 2) => `$${plain(value, digits)}`;
  return {
    formatCurrency: (value: number, _code?: string, digits?: number) =>
      money(value, digits ?? 2),
    formatCurrencyPrecise: (value: number, _code?: string, digits?: number) =>
      money(value, digits ?? 2),
    formatCurrencyCompact: (value: number) => money(value, 0),
    formatCurrencyAxis: (value: number) => money(value, 0),
    // Through Intl's own compact notation, so a default is the shape the real
    // formatter produces ("$13.3K") rather than a full figure a narrow-cell
    // assertion would pass against by accident.
    formatCurrencyTight: (value: number) =>
      new Intl.NumberFormat('en-US', {
        style: 'currency',
        currency: 'USD',
        currencyDisplay: 'narrowSymbol',
        notation: 'compact',
        compactDisplay: 'short',
        maximumFractionDigits: Math.abs(value) < 1000 ? 0 : 1,
      }).format(value),
    formatCurrencyFlag: (value: number) => money(value, 2),
    formatCurrencyLabel: (value: number) => money(value, 2),
    formatNumber: (value: number, digits = 2) => plain(value, digits),
    // Through the same Intl unit style the real hook uses, so a default is not
    // quietly a different renderer from the one production runs.
    formatBytes: (value: number) => {
      const { value: scaled, unit, decimals } = scaleBytes(value);
      return new Intl.NumberFormat('en-US', {
        style: 'unit',
        unit,
        unitDisplay: 'short',
        minimumFractionDigits: decimals,
        maximumFractionDigits: decimals,
      }).format(scaled);
    },
    formatPercent: (value: number, digits = 2) => `${plain(value, digits)}%`,
    formatPercentTrimmed: (value: number) =>
      `${new Intl.NumberFormat('en-US', { maximumFractionDigits: 4 }).format(value)}%`,
    formatSignedPercent: (value: number, digits = 2) =>
      `${value >= 0 ? '+' : ''}${plain(value, digits)}%`,
    formatQuantity: (value: number) => String(value),
    formatShareQuantity: (value: number | null | undefined) =>
      value === null || value === undefined || Number.isNaN(value)
        ? '0'
        : String(value),
    formatPrice: (value: number) => String(value),
    numberSeparators: { decimal: '.', group: ',' },
  };
}
