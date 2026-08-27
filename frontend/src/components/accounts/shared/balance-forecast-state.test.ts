import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BalanceForecast } from '@/types/banking-detail';
import {
  EMPTY_BALANCE_FORECAST_STATE,
  projectedBalanceFrom,
  readBalanceForecast,
} from './balance-forecast-state';

const forecast = (over: Partial<BalanceForecast> = {}): BalanceForecast => ({
  accountId: 'acc-1',
  currencyCode: 'USD',
  points: [
    { date: '2026-03-01', balance: 100 },
    { date: '2026-03-31', balance: 250 },
  ],
  complete: true,
  gaps: [],
  ...over,
});

describe('readBalanceForecast', () => {
  it('adopts a complete forecast', () => {
    const state = readBalanceForecast(forecast());
    expect(state.withheld).toBe(false);
    expect(state.points).toHaveLength(2);
    expect(state.gaps).toEqual([]);
  });

  it('withholds the points when the server says it withheld the line', () => {
    const state = readBalanceForecast(
      forecast({
        complete: false,
        points: [{ date: '2026-03-01', balance: 100 }],
        gaps: [
          {
            scheduledTransactionId: 'st-1',
            name: 'Monthly ETF buy',
            reason: 'unresolvedSettlementRate',
            fromCurrency: 'CAD',
            toCurrency: 'USD',
          },
        ],
      }),
    );
    expect(state.withheld).toBe(true);
    // Not even the anchor: adopting it draws a line that stops at today.
    expect(state.points).toEqual([]);
    expect(state.gaps).toHaveLength(1);
  });

  /**
   * The regression this module exists for.
   *
   * `complete === false` with an EMPTY gap list is a withheld projection the
   * server did not attribute. Read through `gaps.length > 0` -- which is how the
   * two detail views derived it at their render sites -- it came out as "the
   * forecast is fine", so the unavailable panel did not render and the projected
   * balance fell back to the account's CURRENT balance: today's figure printed
   * under "Projected", with nothing on screen saying so.
   */
  it('is withheld even when the server names no cause', () => {
    const state = readBalanceForecast(
      forecast({ complete: false, points: [], gaps: [] }),
    );
    expect(state.withheld).toBe(true);
    expect(state.points).toEqual([]);
    expect(projectedBalanceFrom(state, 1234)).toBeNull();
  });

  it('reads an absent flag as no information, not as withheld', () => {
    // An older backend mid rolling deploy sends no `complete`. Withholding on
    // absence would invent a problem the response never reported.
    const { complete: _complete, ...withoutFlag } = forecast();
    const state = readBalanceForecast(withoutFlag as BalanceForecast);
    expect(state.withheld).toBe(false);
    expect(state.points).toHaveLength(2);
  });

  it('treats a failed request as no forecast, not as a withheld one', () => {
    expect(readBalanceForecast(null)).toEqual(EMPTY_BALANCE_FORECAST_STATE);
    expect(readBalanceForecast(undefined)).toEqual(EMPTY_BALANCE_FORECAST_STATE);
    // No claim about WHY, because nothing was learned about the schedules.
    expect(readBalanceForecast(null).gaps).toEqual([]);
    expect(readBalanceForecast(null).withheld).toBe(false);
  });

  /**
   * A failed request is a THIRD state, and the one that costs a number.
   *
   * Folded into `withheld: false` alongside "this account has nothing
   * scheduled", a 500 on the forecast endpoint made `projectedBalanceFrom` fall
   * back to the account's CURRENT balance and print it under "Projected" with
   * nothing on screen saying so -- an outage rendered as a measured answer,
   * which is the same class of mistake as drawing a withheld projection.
   */
  it('does not project from the current balance when the request failed', () => {
    const failed = readBalanceForecast(null);
    expect(failed.unavailable).toBe(true);
    expect(projectedBalanceFrom(failed, 1234)).toBeNull();
  });

  it('separates a failed request from an account with nothing scheduled', () => {
    // Empty is a known answer (project to what it holds now); failed is not.
    const empty = readBalanceForecast(forecast({ points: [] }));
    expect(empty.unavailable).toBe(false);
    expect(projectedBalanceFrom(empty, 1234)).toBe(1234);
  });
});

describe('projectedBalanceFrom', () => {
  it('is the forecast’s last point when the forecast is complete', () => {
    expect(projectedBalanceFrom(readBalanceForecast(forecast()), 999)).toBe(250);
  });

  it('is unknown when the projection is withheld', () => {
    const state = readBalanceForecast(forecast({ complete: false, gaps: [] }));
    expect(projectedBalanceFrom(state, 999)).toBeNull();
  });

  it('is the current balance for an account with nothing scheduled', () => {
    // Empty is not unknown: an account with no upcoming activity projects to
    // what it holds now, which is a known answer.
    const state = readBalanceForecast(forecast({ points: [] }));
    expect(projectedBalanceFrom(state, 999)).toBe(999);
  });
});

describe('the withholding rule has one home', () => {
  /**
   * A scanning guard rather than a per-view test: the defect was two views each
   * asking the question twice, so what has to hold is that no OTHER file asks it
   * at all. A component test on either view would have passed throughout.
   */
  const accountsRoot = join(__dirname, '..');
  const viewFiles = [
    'banking-detail/BankingDetailView.tsx',
    'credit-card-detail/CreditCardDetailView.tsx',
  ];

  it('is not re-derived at a detail view', () => {
    for (const file of viewFiles) {
      const source = readFileSync(join(accountsRoot, file), 'utf8');
      expect(source).toContain('readBalanceForecast');
      // Neither half of the old pair: not the raw completeness test, and not the
      // gap-count stand-in for it.
      expect(source).not.toMatch(/complete\s*===\s*false/);
      expect(source).not.toMatch(/forecastGaps\.length\s*>\s*0/);
      expect(source).not.toMatch(/gaps\.length\s*>\s*0/);
    }
  });

  it('renders the panel off the state, never off the gap list', () => {
    for (const file of viewFiles) {
      const source = readFileSync(join(accountsRoot, file), 'utf8');
      const panel = source.indexOf('<BalanceForecastUnavailable');
      expect(panel).toBeGreaterThan(-1);
      // The condition sits immediately above the element, and covers both
      // states that leave the reader without a forward line.
      const condition = source.slice(Math.max(0, panel - 200), panel);
      expect(condition).toContain('forecast.withheld');
      expect(condition).toContain('forecast.unavailable');
    }
  });
});
