import { describe, expect, it, vi } from 'vitest';
import { renderHook } from '@/test/render';
import { useRuleChangeText, type RuleChangeNames } from './use-rule-change-text';
import type { RuleLoanSettlementPlan, RuleRunChanges } from '@/types/transaction-rule-run';

vi.mock('@/hooks/useNumberFormat', async () => {
  const { numberFormatMockDefaults } = await import('@/test/number-format-mock');
  return {
    useNumberFormat: () => ({
      ...numberFormatMockDefaults(),
      formatCurrency: (value: number, code?: string) => `${code} ${value.toFixed(2)}`,
    }),
  };
});

const LOAN = '11111111-1111-4111-8111-000000000002';

const names: RuleChangeNames = {
  category: () => undefined,
  payee: () => undefined,
  tag: () => undefined,
  account: (id) => (id === LOAN ? 'Mortgage' : undefined),
};

/** The spec's worked example: LINEAR EUR 300,000 at 2 %, a debit of 1,533.33 on the first slot. */
function plan(lines: { principal: string; interest: string; extra: string }, debtBefore = '300000.0000'): RuleLoanSettlementPlan {
  return {
    loanAccountId: LOAN,
    scheduledTransactionId: 'schedule-1',
    dueDate: '2024-01-01',
    installmentNumber: 1,
    pricing: {
      dueDate: '2024-01-01',
      installmentNumber: 1,
      method: 'LINEAR',
      prepaymentMode: 'REDUCE_TERM',
      currencyCode: 'EUR',
      debtLedger: debtBefore,
      foldedPrincipal: '0.0000',
      debtBefore,
      annualRate: '2',
      periodicRate: 0.02 / 12,
      priced: { principal: '833.3333', interest: '500.0000', extra: '0.0000', total: '1333.3333' },
      booked: { principal: '833.33', interest: '500.00', extra: '0.00', total: '1333.33' },
      paid: '1533.33',
      difference: '200.00',
      outcome: 'extra_principal',
      lines,
    },
  };
}

function lines(changes: RuleRunChanges, done = false): string[] {
  const { result } = renderHook(() => useRuleChangeText());
  return result.current(changes, names, { currencyCode: 'EUR', done });
}

describe('useRuleChangeText: a loan settlement', () => {
  it('names the installment, its lines, the extra principal and the debt it was priced on', () => {
    const text = lines({
      loanSettlement: { before: null, after: plan({ principal: '833.33', interest: '500.00', extra: '200.00' }) },
    });
    expect(text).toHaveLength(1);
    expect(text[0]).toMatch(/^Settles installment 1 of Mortgage, due /);
    expect(text[0]).toContain('principal EUR 833.33, interest EUR 500.00, extra principal EUR 200.00.');
    expect(text[0]).toMatch(/Debt before: EUR 300000\.00$/);
  });

  it('leaves the extra principal out when there is none, and reads a written settlement in the past', () => {
    const text = lines(
      { loanSettlement: { before: null, after: plan({ principal: '833.33', interest: '498.61', extra: '0.00' }, '299166.6700') } },
      true,
    );
    expect(text[0]).toMatch(/^Settled installment 1 of Mortgage/);
    expect(text[0]).toContain('principal EUR 833.33, interest EUR 498.61.');
    expect(text[0]).not.toContain('extra principal');
    expect(text[0]).toMatch(/Debt before: EUR 299166\.67$/);
  });

  it('puts the settlement line before the split it plans', () => {
    const text = lines({
      loanSettlement: { before: null, after: plan({ principal: '833.33', interest: '500.00', extra: '0.00' }) },
      structure: {
        before: null,
        after: {
          kind: 'split',
          parts: [
            { amount: -833.33, categoryId: null, transferAccountId: LOAN, payeeId: null, memo: 'Principal' },
            { amount: -500, categoryId: null, transferAccountId: null, payeeId: null, memo: 'Interest' },
          ],
        },
      },
    });
    expect(text[0]).toMatch(/^Settles installment 1/);
    expect(text[1]).toBe('Will be split into 2 parts');
  });

  it('names a deleted loan instead of leaking its id', () => {
    const settled = { ...plan({ principal: '1', interest: '1', extra: '0' }), loanAccountId: 'gone' };
    const text = lines({ loanSettlement: { before: null, after: settled } });
    expect(text[0]).toMatch(/^Settles installment 1 of a deleted item, due /);
  });
});
