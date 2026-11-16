import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildCsvContent, exportCsvSections } from '@/lib/csv-export';
import type { Warranty } from '@/types/warranty';
import {
  WARRANTY_CSV_HEADERS,
  exportWarrantiesCsv,
  serialNumbersCsvCell,
  warrantiesToCsvSection,
} from './warranty-csv-export';

vi.mock('@/lib/csv-export', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/csv-export')>()),
  exportCsvSections: vi.fn(),
}));

const REPO_ROOT = join(__dirname, '..', '..', '..', '..');

/** The column list the importer resolves headers against, read from its source. */
function backendCsvColumns(): string[] {
  const source = readFileSync(join(REPO_ROOT, 'backend/src/warranties/warranty-csv.ts'), 'utf8');
  const match = /export const WARRANTY_CSV_COLUMNS = \[([\s\S]*?)\] as const;/.exec(source);
  if (!match) throw new Error('WARRANTY_CSV_COLUMNS not found in backend/src/warranties/warranty-csv.ts');
  return [...match[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
}

function warranty(overrides: Partial<Warranty> = {}): Warranty {
  return {
    id: 'w-1',
    name: 'Laptop',
    vendorName: 'Best Buy',
    payeeId: null,
    payee: null,
    modelNumber: 'XPS-13',
    serialNumbers: ['SN1', 'SN2'],
    warrantyKind: 'extended',
    purchaseDate: '2026-01-31',
    expiresOn: '2028-01-31',
    isLifetime: false,
    purchasePrice: 1299.99,
    currencyCode: 'CAD',
    productUrl: 'https://example.com/xps',
    notes: 'Kept the box',
    today: '2026-10-21',
    status: 'active',
    daysLeft: 467,
    documentCount: 0,
    openClaimCount: 0,
    linkedTransactionHidden: false,
    linkedTransaction: null,
    archivedAt: null,
    createdAt: '2026-01-31T00:00:00Z',
    updatedAt: '2026-01-31T00:00:00Z',
    ...overrides,
  };
}

describe('warrantiesToCsvSection', () => {
  beforeEach(() => vi.clearAllMocks());

  it("writes the header line the importer resolves, in Warracker's order", () => {
    const text = buildCsvContent([warrantiesToCsvSection([])]);
    expect(text).toBe(backendCsvColumns().join(','));
    expect([...WARRANTY_CSV_HEADERS]).toEqual(backendCsvColumns());
  });

  it('fills ExpirationDate and leaves the duration columns and Tags empty', () => {
    const { rows } = warrantiesToCsvSection([warranty()]);
    expect(rows).toEqual([
      [
        'Laptop',
        '2026-01-31',
        '',
        '',
        '',
        '2028-01-31',
        'false',
        1299.99,
        'SN1,SN2',
        'https://example.com/xps',
        'Best Buy',
        '',
        'Kept the box',
        'CAD',
        'XPS-13',
        'extended',
      ],
    ]);
  });

  it('writes a lifetime warranty with no expiry and IsLifetime true', () => {
    const { rows } = warrantiesToCsvSection([
      warranty({ isLifetime: true, expiresOn: null, status: 'lifetime', daysLeft: null }),
    ]);
    expect(rows[0][5]).toBe('');
    expect(rows[0][6]).toBe('true');
  });

  it('writes the price the API sent as a string as a number, and no price as blanks', () => {
    const asString = warranty({ purchasePrice: '67.9900' as unknown as number });
    const none = warranty({ purchasePrice: null, currencyCode: null });
    const { rows } = warrantiesToCsvSection([asString, none]);
    expect(rows[0][7]).toBe(67.99);
    expect(rows[1][7]).toBe('');
    expect(rows[1][13]).toBe('');
  });

  it('writes blank optional fields as empty cells', () => {
    const { rows } = warrantiesToCsvSection([
      warranty({ vendorName: null, modelNumber: null, serialNumbers: [], productUrl: null, notes: null }),
    ]);
    expect([rows[0][8], rows[0][9], rows[0][10], rows[0][12], rows[0][14]]).toEqual(['', '', '', '', '']);
  });

  it('JSON-encodes the serials when one holds a comma, and the file quotes the cell', () => {
    const section = warrantiesToCsvSection([warranty({ serialNumbers: ['A,1', 'B2'] })]);
    expect(section.rows[0][8]).toBe('["A,1","B2"]');
    const dataLine = buildCsvContent([section]).split('\r\n')[1];
    expect(dataLine).toContain('"[""A,1"",""B2""]"');
  });
});

describe('serialNumbersCsvCell', () => {
  it('comma-joins plain serials', () => {
    expect(serialNumbersCsvCell(['X1', 'X2', 'X3'])).toBe('X1,X2,X3');
  });

  it('is empty for no serials', () => {
    expect(serialNumbersCsvCell([])).toBe('');
  });

  it('JSON-encodes a first serial that opens with [, which the importer would read as JSON', () => {
    expect(serialNumbersCsvCell(['[A]', 'B'])).toBe('["[A]","B"]');
  });
});

describe('exportWarrantiesCsv', () => {
  it('hands one section to the shared writer', () => {
    exportWarrantiesCsv([warranty()], 'warranties-2026-10-21');
    expect(exportCsvSections).toHaveBeenCalledWith('warranties-2026-10-21', [
      warrantiesToCsvSection([warranty()]),
    ]);
  });
});
