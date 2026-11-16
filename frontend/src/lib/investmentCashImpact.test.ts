import { describe, expect, it } from 'vitest';
import {
  computeInvestmentCashImpact,
  isInvestmentActionAllowedInSplit,
  EMBEDDED_INVESTMENT_SPLIT_ACTIONS,
} from './investmentCashImpact';

describe('computeInvestmentCashImpact', () => {
  it('returns -750 for BUY 75 @ $10', () => {
    expect(computeInvestmentCashImpact('BUY', 75, 10, 0)).toBe(-750);
  });

  it('adds commission to BUY total', () => {
    expect(computeInvestmentCashImpact('BUY', 100, 50, 9.99)).toBe(-5009.99);
  });

  it('subtracts commission from SELL', () => {
    expect(computeInvestmentCashImpact('SELL', 100, 50, 9.99)).toBe(4990.01);
  });

  it('treats DIVIDEND with default qty=1', () => {
    expect(computeInvestmentCashImpact('DIVIDEND', 0, 25.5, 0)).toBe(25.5);
    expect(computeInvestmentCashImpact('DIVIDEND', 1, 25.5, 0)).toBe(25.5);
  });

  it('credits a return of capital like a dividend (issue #1800)', () => {
    expect(computeInvestmentCashImpact('RETURN_OF_CAPITAL', 0, 40, 0)).toBe(40);
    expect(isInvestmentActionAllowedInSplit('RETURN_OF_CAPITAL')).toBe(true);
  });

  it('returns 0 for REINVEST', () => {
    expect(computeInvestmentCashImpact('REINVEST', 5, 10, 0)).toBe(0);
  });

  it('returns 0 for share-only actions', () => {
    expect(computeInvestmentCashImpact('ADD_SHARES', 10, 0, 0)).toBe(0);
    expect(computeInvestmentCashImpact('REMOVE_SHARES', 10, 0, 0)).toBe(0);
    expect(computeInvestmentCashImpact('TRANSFER_IN', 10, 5, 0)).toBe(0);
    expect(computeInvestmentCashImpact('SPLIT', 2, 0, 0)).toBe(0);
  });
});

describe('isInvestmentActionAllowedInSplit', () => {
  it('allows the cash-impacting subset', () => {
    EMBEDDED_INVESTMENT_SPLIT_ACTIONS.forEach((a) =>
      expect(isInvestmentActionAllowedInSplit(a)).toBe(true),
    );
  });

  it('rejects share-only actions', () => {
    (['ADD_SHARES', 'REMOVE_SHARES', 'TRANSFER_IN', 'SPLIT'] as const).forEach(
      (a) => expect(isInvestmentActionAllowedInSplit(a)).toBe(false),
    );
  });
});
