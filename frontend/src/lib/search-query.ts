/**
 * Builds one qualified term of the Transactions search syntax, for a link
 * that opens the register on a known value (a report's payee, a row's
 * description). The value is quoted so spaces reach the server's parser as one
 * term rather than as several AND-ed words, and `\` and `"` are escaped the
 * way the parser reads them (docs/specs/advanced-search.md, section
 * 4.1). A `*` in the value stays a wildcard -- the syntax has no literal
 * star -- which still matches the value itself.
 */

export type SearchQualifierField = 'payee' | 'memo' | 'cat' | 'tag' | 'account' | 'ref';

export type SearchQualifierMatch = 'exact' | 'contains';

export function quoteSearchValue(
  field: SearchQualifierField,
  value: string,
  match: SearchQualifierMatch = 'exact',
): string {
  const escaped = value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  return `${field}:${match === 'exact' ? '=' : ''}"${escaped}"`;
}
