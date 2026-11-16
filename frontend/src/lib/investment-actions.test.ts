import { describe, it, expect } from 'vitest';
import { TransactionStatus } from '@/types/transaction';
import {
  baseInvestmentAction,
  CASH_INCOME_ACTIONS,
  INCOME_ACTIONS,
  incomeBaseKind,
  incomeKind,
  investmentIncomeAmount,
  investmentRowHasEffect,
  redemptionTotalWithInterest,
  REINVESTED_INCOME_ACTIONS,
  supportsAccruedInterest,
} from './investment-actions';

describe('baseInvestmentAction', () => {
  it('normalizes each Money-vocabulary refinement to its base', () => {
    expect(baseInvestmentAction('REDEEM')).toBe('SELL');
    expect(baseInvestmentAction('REINVEST_INTEREST')).toBe('REINVEST');
    expect(baseInvestmentAction('CAPITAL_GAIN_LONG')).toBe('CAPITAL_GAIN');
  });

  it('leaves a base action alone', () => {
    expect(baseInvestmentAction('BUY')).toBe('BUY');
  });
});

describe('supportsAccruedInterest', () => {
  it('is REDEEM alone', () => {
    expect(supportsAccruedInterest('REDEEM')).toBe(true);
    expect(supportsAccruedInterest('SELL')).toBe(false);
    expect(supportsAccruedInterest('INTEREST')).toBe(false);
  });

  it('does not follow REDEEM to its base action', () => {
    // REDEEM normalizes to SELL, so a check written against the base would put
    // the field on every sale -- which the backend then refuses.
    expect(supportsAccruedInterest(baseInvestmentAction('REDEEM'))).toBe(false);
  });
});

describe('redemptionTotalWithInterest', () => {
  it('adds the interest to the proceeds', () => {
    expect(redemptionTotalWithInterest(9975, 87.5)).toBe(10062.5);
  });

  it('treats an absent field as no interest', () => {
    // A backend that predates the field sends nothing; the row is still a
    // redemption and its proceeds are still the whole story.
    expect(redemptionTotalWithInterest(9975, undefined)).toBe(9975);
    expect(redemptionTotalWithInterest(9975, null)).toBe(9975);
  });

  it('rounds the sum, not only its operands', () => {
    expect(redemptionTotalWithInterest(1005.1234, 87.5678)).toBe(1092.6912);
  });
});

describe('incomeKind', () => {
  it('records a reinvested distribution as income of its cash twin', () => {
    expect(incomeKind('REINVEST')).toBe('DIVIDEND');
    expect(incomeKind('REINVEST_INTEREST')).toBe('INTEREST');
    expect(incomeKind('REINVEST_CAPITAL_GAIN_SHORT')).toBe('CAPITAL_GAIN_SHORT');
    expect(incomeKind('REINVEST_CAPITAL_GAIN_LONG')).toBe('CAPITAL_GAIN_LONG');
  });

  it('records a cash distribution as itself, and a trade as none', () => {
    expect(incomeKind('DIVIDEND')).toBe('DIVIDEND');
    expect(incomeKind('CAPITAL_GAIN_LONG')).toBe('CAPITAL_GAIN_LONG');
    expect(incomeKind('BUY')).toBeNull();
    expect(incomeKind('SPLIT')).toBeNull();
  });

  it('buckets every distribution, cash or reinvested, under its base kind', () => {
    expect(incomeBaseKind('REINVEST')).toBe('DIVIDEND');
    expect(incomeBaseKind('REINVEST_INTEREST')).toBe('INTEREST');
    expect(incomeBaseKind('REINVEST_CAPITAL_GAIN_LONG')).toBe('CAPITAL_GAIN');
    expect(incomeBaseKind('CAPITAL_GAIN_SHORT')).toBe('CAPITAL_GAIN');
    expect(incomeBaseKind('SELL')).toBeNull();
  });

  it('records no income for a return of capital: it pays back cost (issue #1800)', () => {
    expect(baseInvestmentAction('RETURN_OF_CAPITAL')).toBe('RETURN_OF_CAPITAL');
    expect(incomeKind('RETURN_OF_CAPITAL')).toBeNull();
    expect(INCOME_ACTIONS).not.toContain('RETURN_OF_CAPITAL');
    expect(
      investmentIncomeAmount({
        action: 'RETURN_OF_CAPITAL',
        quantity: null,
        price: null,
        commission: null,
        totalAmount: 40,
      }),
    ).toBe(0);
  });

  it('lists the reinvestments as income but not as cash income', () => {
    for (const action of REINVESTED_INCOME_ACTIONS) {
      expect(CASH_INCOME_ACTIONS).not.toContain(action);
      expect(INCOME_ACTIONS).toContain(action);
    }
    expect(REINVESTED_INCOME_ACTIONS).toHaveLength(4);
  });
});

describe('investmentIncomeAmount', () => {
  const row = (over: Partial<Parameters<typeof investmentIncomeAmount>[0]>) => ({
    action: 'DIVIDEND' as const,
    quantity: null,
    price: null,
    commission: null,
    totalAmount: 0,
    ...over,
  });

  it('is a cash distribution\'s total, unsigned', () => {
    expect(investmentIncomeAmount(row({ totalAmount: -12.5 }))).toBe(12.5);
  });

  it('values a reinvest the app wrote, with no total, at quantity x price + commission', () => {
    expect(
      investmentIncomeAmount(
        row({ action: 'REINVEST', quantity: 3, price: 20, commission: 0.5, totalAmount: 0 }),
      ),
    ).toBe(60.5);
  });

  it('values an imported reinvest at the total it carries', () => {
    expect(
      investmentIncomeAmount(
        row({ action: 'REINVEST_INTEREST', quantity: 3, price: 20, totalAmount: 61 }),
      ),
    ).toBe(61);
  });

  it('values an imported reinvest that carries a total but no price at that total', () => {
    expect(
      investmentIncomeAmount(row({ action: 'REINVEST', quantity: 10, price: null, totalAmount: 500 })),
    ).toBe(500);
  });

  it('leaves out a reinvest with neither a total nor a price, as the basis does', () => {
    expect(
      investmentIncomeAmount(row({ action: 'REINVEST', quantity: 3, price: 0, totalAmount: 0 })),
    ).toBe(0);
  });

  it('is zero for a trade', () => {
    expect(
      investmentIncomeAmount(row({ action: 'BUY', quantity: 1, price: 10, totalAmount: 10 })),
    ).toBe(0);
  });
});

describe('investmentRowHasEffect', () => {
  it('drops a VOID row, which moved nothing, and keeps every other status', () => {
    expect(investmentRowHasEffect({ status: TransactionStatus.VOID })).toBe(false);
    expect(investmentRowHasEffect({ status: TransactionStatus.CLEARED })).toBe(true);
    expect(investmentRowHasEffect({ status: TransactionStatus.UNRECONCILED })).toBe(true);
  });
});
