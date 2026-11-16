import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { holdingsPhonePlacement } from './holdings-phone-grid';

describe('holdingsPhonePlacement', () => {
  it('places every figure where the rows carried it before columns could be hidden', () => {
    // The literal classes of GroupedHoldingsList's three row kinds with nothing
    // hidden, so the default empty set renders byte for byte as before.
    expect(holdingsPhonePlacement(new Set())).toEqual({
      row: {
        shares: 'col-start-1 row-start-2',
        avgCost: 'col-start-2 row-start-2',
        price: 'col-start-3 row-start-2',
        costBasis: 'col-start-1 col-span-2 row-start-3',
        mktValue: 'col-start-3 col-span-2 row-start-1',
        gainLoss: 'col-start-3 col-span-2 row-start-3',
        portfolioPercent: 'col-start-4 row-start-2',
      },
      total: {
        costBasis: 'col-start-1 col-span-2 row-start-2',
        mktValue: 'col-start-3 col-span-2 row-start-1',
        gainLoss: 'col-start-3 col-span-2 row-start-2',
        portfolioPercent: 'col-start-1 col-span-2 row-start-3',
      },
    });
  });

  it('packs the second line from column 1 when a per-share figure is hidden', () => {
    expect(holdingsPhonePlacement(new Set(['avgCost']))).toEqual({
      row: {
        shares: 'col-start-1 row-start-2',
        price: 'col-start-2 row-start-2',
        portfolioPercent: 'col-start-3 row-start-2',
        costBasis: 'col-start-1 col-span-2 row-start-3',
        mktValue: 'col-start-3 col-span-2 row-start-1',
        gainLoss: 'col-start-3 col-span-2 row-start-3',
      },
      // The account-total row carries no per-share figure, so it is unchanged.
      total: {
        costBasis: 'col-start-1 col-span-2 row-start-2',
        mktValue: 'col-start-3 col-span-2 row-start-1',
        gainLoss: 'col-start-3 col-span-2 row-start-2',
        portfolioPercent: 'col-start-1 col-span-2 row-start-3',
      },
    });
  });

  it('moves the third line up when the whole second line is hidden', () => {
    expect(
      holdingsPhonePlacement(new Set(['shares', 'avgCost', 'price', 'portfolioPercent', 'costBasis'])),
    ).toEqual({
      row: {
        mktValue: 'col-start-3 col-span-2 row-start-1',
        gainLoss: 'col-start-1 col-span-2 row-start-2',
      },
      total: {
        mktValue: 'col-start-3 col-span-2 row-start-1',
        gainLoss: 'col-start-1 col-span-2 row-start-2',
      },
    });
  });

  it('places nothing but the fixed first cell when every figure is hidden', () => {
    expect(
      holdingsPhonePlacement(
        new Set(['shares', 'avgCost', 'price', 'costBasis', 'mktValue', 'gainLoss', 'portfolioPercent']),
      ),
    ).toEqual({ row: {}, total: {} });
  });

  it('packs the account-total figures two to a line when Mkt Value and Gain/Loss are hidden', () => {
    expect(holdingsPhonePlacement(new Set(['mktValue', 'gainLoss'])).total).toEqual({
      costBasis: 'col-start-1 col-span-2 row-start-2',
      portfolioPercent: 'col-start-3 col-span-2 row-start-2',
    });
  });

  it('spells every class it can return as a whole literal in its source', () => {
    // Tailwind only generates a class it finds whole in a source file, so a
    // placement assembled from parts would render unplaced in production.
    const source = readFileSync(join(__dirname, 'holdings-phone-grid.ts'), 'utf8');
    const columns = ['shares', 'avgCost', 'price', 'costBasis', 'mktValue', 'gainLoss', 'portfolioPercent'];
    const reachable = new Set<string>();
    for (let mask = 0; mask < 1 << columns.length; mask++) {
      const hidden = new Set(columns.filter((_, i) => mask & (1 << i)));
      const { row, total } = holdingsPhonePlacement(hidden);
      for (const value of [...Object.values(row), ...Object.values(total)]) {
        reachable.add(value);
      }
    }
    for (const value of reachable) {
      expect(source).toContain(`'${value}'`);
    }
  });
});
