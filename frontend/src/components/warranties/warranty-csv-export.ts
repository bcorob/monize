import { exportCsvSections, type CsvSection, type CsvValue } from '@/lib/csv-export';
import type { Warranty } from '@/types/warranty';

/**
 * Warracker's CSV column set, in its order (design decision 12), so a file
 * exported here imports through `POST /warranties/import` and into Warracker.
 * The same list as `WARRANTY_CSV_COLUMNS` in
 * `backend/src/warranties/warranty-csv.ts`, which reads it.
 */
export const WARRANTY_CSV_HEADERS = [
  'ProductName',
  'PurchaseDate',
  'WarrantyDurationYears',
  'WarrantyDurationMonths',
  'WarrantyDurationDays',
  'ExpirationDate',
  'IsLifetime',
  'PurchasePrice',
  'SerialNumber',
  'ProductURL',
  'Vendor',
  'Tags',
  'Notes',
  'Currency',
  'ModelNumber',
  'WarrantyType',
] as const;

/**
 * `SerialNumber`: comma-joined, or a JSON array when the comma join could
 * not be read back -- a serial holding a comma, or a first serial opening
 * with `[`, which the importer reads as the start of a JSON array.
 */
export function serialNumbersCsvCell(serials: readonly string[]): string {
  if (serials.length === 0) return '';
  const needsJson = serials.some((s) => s.includes(',')) || serials[0].startsWith('[');
  return needsJson ? JSON.stringify(serials) : serials.join(',');
}

function warrantyCsvRow(warranty: Warranty): CsvValue[] {
  return [
    warranty.name,
    warranty.purchaseDate,
    // The stored fact is the date (decision 1), so the duration columns stay
    // empty and ExpirationDate carries it; a lifetime warranty has neither.
    '',
    '',
    '',
    warranty.isLifetime ? '' : (warranty.expiresOn ?? ''),
    warranty.isLifetime ? 'true' : 'false',
    // A decimal crosses the wire as a string; the cell is the number.
    warranty.purchasePrice === null ? '' : Number(warranty.purchasePrice),
    serialNumbersCsvCell(warranty.serialNumbers),
    warranty.productUrl ?? '',
    warranty.vendorName ?? '',
    // No tags on a warranty in v1 (decision 14).
    '',
    warranty.notes ?? '',
    warranty.currencyCode ?? '',
    warranty.modelNumber ?? '',
    warranty.warrantyKind,
  ];
}

/** The warranties as one CSV table in Warracker's columns. */
export function warrantiesToCsvSection(rows: readonly Warranty[]): CsvSection {
  return { headers: [...WARRANTY_CSV_HEADERS], rows: rows.map(warrantyCsvRow) };
}

/** Writes the warranties through the one CSV writer and hands the file to the browser. */
export function exportWarrantiesCsv(rows: readonly Warranty[], filename: string): void {
  exportCsvSections(filename, [warrantiesToCsvSection(rows)]);
}
