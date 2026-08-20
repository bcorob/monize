import { describe, it, expect } from 'vitest';
import {
  baseInvestmentAction,
  redemptionTotalWithInterest,
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
