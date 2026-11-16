import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { RECURRING_EXPENSE_FREQUENCIES } from './built-in-reports';

const REPO_ROOT = join(__dirname, '..', '..', '..');

function backendDtoSource(): string {
  return readFileSync(
    join(REPO_ROOT, 'backend/src/built-in-reports/dto/recurring-expenses.dto.ts'),
    'utf8',
  );
}

function uncategorizedBackendDtoSource(): string {
  return readFileSync(
    join(REPO_ROOT, 'backend/src/built-in-reports/dto/uncategorized-transactions.dto.ts'),
    'utf8',
  );
}

function frontendTypesSource(): string {
  return readFileSync(join(__dirname, 'built-in-reports.ts'), 'utf8');
}

function billPaymentBackendDtoSource(): string {
  return readFileSync(
    join(REPO_ROOT, 'backend/src/built-in-reports/dto/bill-payment-history.dto.ts'),
    'utf8',
  );
}

/**
 * Blank out comment bodies, keeping line breaks.
 *
 * The declarations scanned below are where the "no display string on the wire"
 * rule has to be explained, and the explanation must be free to name the field
 * it removed -- a scan that reads its own documentation as a violation
 * pressures the next author into a vaguer comment. Same technique as
 * `lib/loan-history.guard.test.ts`.
 */
function withoutComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (match) => match.replace(/[^\n]/g, ' '))
    .replace(
      /(^|[^:])\/\/[^\n]*/g,
      (match, before: string) =>
        before + ' '.repeat(match.length - before.length),
    );
}

function backendFrequencyCodes(source: string): string[] {
  const declaration = source.match(
    /export const RECURRING_EXPENSE_FREQUENCIES\s*=\s*\[([\s\S]*?)\]\s*as const/,
  );
  expect(declaration, 'backend recurring-expense frequency list not found').toBeTruthy();
  return [...declaration![1].matchAll(/"([A-Z]+)"/g)].map((match) => match[1]);
}

describe('recurring-expenses API contract', () => {
  it('keeps the frontend frequency union equal to the backend DTO enum', () => {
    expect(backendFrequencyCodes(backendDtoSource())).toEqual([
      ...RECURRING_EXPENSE_FREQUENCIES,
    ]);
  });

  it('keeps an absent category structural instead of substituting display copy', () => {
    expect(backendDtoSource()).toMatch(/categoryName:\s*string\s*\|\s*null/);
  });
});

describe('uncategorized-transactions money contract', () => {
  it('carries a currency code beside every transaction amount in both layers', () => {
    // The class body is read whole: the backend decorates each field with an
    // `@ApiProperty({ ... })` whose braces a `[^}]*` scan cannot cross.
    const backend = withoutComments(uncategorizedBackendDtoSource()).match(
      /class UncategorizedTransactionItem\s*\{([\s\S]*?)\n\}/,
    );
    const frontend = withoutComments(frontendTypesSource()).match(
      /interface UncategorizedTransactionItem\s*\{([\s\S]*?)\n\}/,
    );
    expect(backend, 'backend item class not found').toBeTruthy();
    expect(frontend, 'frontend item type not found').toBeTruthy();

    for (const body of [backend![1], frontend![1]]) {
      expect(body).toMatch(/amount:\s*number;[\s\S]*currencyCode:\s*string;/);
    }
  });

  it('couples every converted summary amount to its destination currency', () => {
    const backend = withoutComments(uncategorizedBackendDtoSource());
    const frontend = withoutComments(frontendTypesSource());

    // A summary total is `null` when a row could not be converted, so the
    // contract is the pair: the (nullable) total, its `known*` subtotal, and the
    // currency both are in -- on both layers.
    const backendShape = backend.match(
      /class UncategorizedTransactionsSummary\s*\{([\s\S]*?)\n\}/,
    );
    const frontendShape = frontend.match(
      /interface UncategorizedTransactionsResponse\s*\{[\s\S]*?summary:\s*\{([\s\S]*?)\n  \};/,
    );
    expect(backendShape, 'backend summary class not found').toBeTruthy();
    expect(frontendShape, 'frontend summary type not found').toBeTruthy();

    for (const body of [backendShape![1], frontendShape![1]]) {
      expect(body).toMatch(/expenseTotal:\s*number\s*\|\s*null;/);
      expect(body).toMatch(/knownExpenseTotal:\s*number;/);
      expect(body).toMatch(/incomeTotal:\s*number\s*\|\s*null;/);
      expect(body).toMatch(/knownIncomeTotal:\s*number;/);
      expect(body).toMatch(/currencyCode:\s*string;/);
    }
  });
});

describe('bill-payment-history month contract', () => {
  /**
   * A month crosses this API as a key, never as a rendered label.
   *
   * `MonthlyBillTotal` used to carry `label`, formatted server-side with
   * `toLocaleDateString("en-US", ...)`. The only consumer already built its own
   * localized label from `month` and overwrote it, so the field was dead
   * payload -- and a dead field named `label` is worse than no field: it is
   * what the next consumer reaches for, shipping English months to 22 locales
   * without touching the server.
   */
  it('carries the month as a key on both layers, with no display string beside it', () => {
    const backend = withoutComments(billPaymentBackendDtoSource());
    const frontend = withoutComments(frontendTypesSource());

    const backendShape = backend.match(/class MonthlyBillTotal\s*\{([\s\S]*?)\n\}/);
    const frontendShape = frontend.match(/interface MonthlyBillTotal\s*\{([\s\S]*?)\n\}/);
    expect(backendShape, 'backend MonthlyBillTotal not found').toBeTruthy();
    expect(frontendShape, 'frontend MonthlyBillTotal not found').toBeTruthy();

    for (const body of [backendShape![1], frontendShape![1]]) {
      expect(body).toMatch(/month:\s*string;/);
      expect(body).toMatch(/total:\s*number;/);
      // No `label`, and no other display string smuggled in under a new name.
      expect(body).not.toMatch(/\blabel\b/);
      expect(body).not.toMatch(/monthLabel|displayMonth|formatted/i);
    }
  });

  it('formats no month for the reader in the service that builds it', () => {
    const service = withoutComments(
      readFileSync(
        join(REPO_ROOT, 'backend/src/built-in-reports/tax-recurring-reports.service.ts'),
        'utf8',
      ),
    );
    // The mechanism was one call. A month rendered on the server is a month
    // rendered in the wrong locale, whatever field it lands in.
    expect(service).not.toMatch(/toLocaleDateString/);
  });
});
