import { describe, it, expect } from 'vitest';
import {
  HIDDEN_COLUMN_TABLES,
  HIDEABLE_COLUMNS,
  hiddenColumnsFor,
  visibleColumns,
  withHiddenColumns,
} from './hidden-columns';
import { REGISTER_COLUMN_ORDER } from '@/components/transactions/register-columns';

describe('HIDEABLE_COLUMNS', () => {
  it('has exactly the HIDDEN_COLUMN_TABLES keys, in order', () => {
    expect(Object.keys(HIDEABLE_COLUMNS)).toEqual([...HIDDEN_COLUMN_TABLES]);
  });

  it('holds the agreed sets', () => {
    expect(HIDEABLE_COLUMNS).toEqual({
      transactions: ['description', 'refNumber', 'tags', 'attachments', 'status'],
      investmentHoldings: [
        'shares',
        'avgCost',
        'price',
        'costBasis',
        'mktValue',
        'gainLoss',
        'portfolioPercent',
      ],
      investmentRegister: ['shares', 'price', 'status'],
    });
  });

  it('lists the register ids in the register column order', () => {
    const order = REGISTER_COLUMN_ORDER as readonly string[];
    const indexes = HIDEABLE_COLUMNS.transactions.map((id) => order.indexOf(id));
    expect(indexes.every((i) => i >= 0)).toBe(true);
    expect([...indexes].sort((a, b) => a - b)).toEqual(indexes);
  });
});

describe('hiddenColumnsFor', () => {
  it('tolerates an undefined or null map', () => {
    expect(hiddenColumnsFor(undefined, 'transactions')).toEqual([]);
    expect(hiddenColumnsFor(null, 'transactions')).toEqual([]);
  });

  it('tolerates a missing or malformed entry', () => {
    expect(hiddenColumnsFor({}, 'investmentHoldings')).toEqual([]);
    expect(
      hiddenColumnsFor(
        { investmentHoldings: 'shares' as unknown as string[] },
        'investmentHoldings',
      ),
    ).toEqual([]);
  });

  it('drops unknown ids and ids of another table kind', () => {
    expect(
      hiddenColumnsFor(
        { transactions: ['tags', 'bogus', 'category', 'avgCost', 42 as unknown as string] },
        'transactions',
      ),
    ).toEqual(['tags']);
  });

  it('dedupes and returns the canonical order', () => {
    expect(
      hiddenColumnsFor({ transactions: ['status', 'tags', 'status'] }, 'transactions'),
    ).toEqual(['tags', 'status']);
  });

  it('reads only its own kind', () => {
    const map = { transactions: ['status'], investmentRegister: ['price'] };
    expect(hiddenColumnsFor(map, 'investmentRegister')).toEqual(['price']);
  });
});

describe('visibleColumns', () => {
  it('keeps the given order and removes the hidden ids', () => {
    expect(
      visibleColumns(['date', 'payee', 'tags', 'amount', 'status'], ['status', 'tags']),
    ).toEqual(['date', 'payee', 'amount']);
  });

  it('accepts a Set', () => {
    expect(visibleColumns(['b', 'a', 'c'], new Set(['a']))).toEqual(['b', 'c']);
  });

  it('returns every column when nothing is hidden', () => {
    expect(visibleColumns(['a', 'b'], [])).toEqual(['a', 'b']);
  });
});

describe('withHiddenColumns', () => {
  it('replaces one kind, dedupes and canonicalises it', () => {
    expect(
      withHiddenColumns({}, 'investmentHoldings', ['price', 'shares', 'price']),
    ).toEqual({ investmentHoldings: ['shares', 'price'] });
  });

  it('keeps the other kinds and does not mutate the input', () => {
    const map = { transactions: ['tags'], investmentRegister: ['status'] };
    const next = withHiddenColumns(map, 'transactions', []);
    expect(next).toEqual({ transactions: [], investmentRegister: ['status'] });
    expect(map).toEqual({ transactions: ['tags'], investmentRegister: ['status'] });
  });

  it('tolerates an undefined map', () => {
    expect(withHiddenColumns(undefined, 'investmentRegister', ['status'])).toEqual({
      investmentRegister: ['status'],
    });
  });
});
