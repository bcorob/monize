/**
 * CSV export utility for report data.
 *
 * This is the one CSV writer in the app: the BOM, the CRLF line endings, the
 * quoting, the formula-injection guard and the download all live here, so a fix
 * reaches every export at once. `src/test/ui-conventions.test.ts` fails the
 * build on a second one.
 */

import { downloadBlob } from './download';

export type CsvValue = string | number | boolean | null | undefined;

/**
 * A block of rows in the file. Most exports are a single section with a header
 * row; a report holding more than one table passes several, and they are
 * separated by a blank line.
 */
export interface CsvSection {
  /** Caption written on its own line above the table. */
  title?: string;
  headers?: string[];
  rows: CsvValue[][];
}

/** Leading characters a spreadsheet may evaluate rather than display. */
const FORMULA_LEAD = /^[=+\-@\t\r]/;

/**
 * Values a spreadsheet reads as a number rather than as a formula.
 *
 * The injection guard keys off the first character, and `-` opens both
 * `-1+cmd|'/c calc'!A0` and every debit in the ledger. Deciding from that
 * character alone made Excel show `-67.99` as the text ` -67.99` for every
 * negative amount in an export (issue #1134): a `decimal(20,4)` column reaches
 * the client as the *string* `"-67.9900"` -- the types say `number`, but nothing
 * transforms it -- so it never took the `typeof value === 'number'` path. Of 64
 * rows the reporter exported, the 5 that came through intact were the splits,
 * whose amount the client recomputes into a real number, and one credit, whose
 * string opens with no character the guard looks for.
 *
 * So ask what the value is instead of what it starts with. A leading sign
 * followed only by digits, separators, whitespace and currency symbols (with an
 * optional trailing `%`) cannot be a formula that does anything: with no
 * letters it names no function and no cell, with no `(`, `|` or `!` it reaches
 * no DDE server or other workbook, and with no interior `+`/`-` it cannot even
 * restate itself as arithmetic. Excel parses such a cell as the number it is,
 * which is what the column wanted. Anything else -- `-1+cmd|run`, `=SUM(A1)`,
 * `@import`, a description that happens to open with a dash -- is text, and
 * keeps the guard.
 *
 * Currency symbols are matched as a Unicode class rather than a list, so this
 * holds for every currency the app supports; a symbol written in letters
 * (`kr`, `zl`, `CHF`) falls outside it and keeps the guard, which is the safe
 * direction to be wrong in. Exponential text (`-1.5e3`) keeps it too: no export
 * produces one -- a real `number` never reaches this test -- and admitting `e`
 * would admit `-E1`, which is a cell reference rather than a number.
 */
const NUMERIC_VALUE =
  /^[+-]?[\p{Nd}\p{Sc}\s.,'’]*\p{Nd}[\p{Nd}\p{Sc}\s.,'’]*%?$/u;

/** True when a spreadsheet would read this text as a number, not a formula. */
function isNumericCsvText(value: string): boolean {
  return NUMERIC_VALUE.test(value);
}

function escapeCsvValue(value: CsvValue): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  let str = value;
  // Prevent CSV formula injection: prefix dangerous leading characters with a
  // tab, unless the value is a number (see NUMERIC_VALUE) -- prefixing one
  // turns the cell into text and the column stops adding up.
  if (str.length > 0 && FORMULA_LEAD.test(str) && !isNumericCsvText(str)) {
    str = `\t${str}`;
  }
  if (str.includes(',') || str.includes('"') || str.includes('\n') || str.includes('\r') || str.includes('\t')) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

function csvLine(values: CsvValue[]): string {
  return values.map(escapeCsvValue).join(',');
}

/** Renders sections to CSV text (no BOM). Exported for tests. */
export function buildCsvContent(sections: CsvSection[]): string {
  const lines = sections.flatMap((section, index) => [
    ...(index > 0 ? [''] : []),
    ...(section.title !== undefined ? [csvLine([section.title])] : []),
    ...(section.headers ? [csvLine(section.headers)] : []),
    ...section.rows.map(csvLine),
  ]);
  return lines.join('\r\n');
}

/**
 * Writes a CSV file holding one or more tables and hands it to the browser.
 * Use `exportToCsv` for the common single-table case.
 */
export function exportCsvSections(filename: string, sections: CsvSection[]): void {
  const blob = new Blob(['\uFEFF' + buildCsvContent(sections)], { type: 'text/csv;charset=utf-8;' });
  downloadBlob(blob, filename.endsWith('.csv') ? filename : `${filename}.csv`);
}

export function exportToCsv(
  filename: string,
  headers: string[],
  rows: CsvValue[][],
): void {
  exportCsvSections(filename, [{ headers, rows }]);
}
