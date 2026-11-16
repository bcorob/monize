/**
 * The table kinds whose inessential columns a user can hide, and the hideable
 * column ids of each, in the table's display order. Every other column is
 * structural and always rendered.
 *
 * These lists are declared again in `frontend/src/lib/hidden-columns.ts`
 * (`HIDEABLE_COLUMNS`); `hidden-table-columns.contract.spec.ts` pins the two
 * equal. The validator refuses any other key or id on write.
 */
export const HIDDEN_COLUMN_TABLES = [
  "transactions",
  "investmentHoldings",
  "investmentRegister",
] as const;

export type HiddenColumnTable = (typeof HIDDEN_COLUMN_TABLES)[number];

export const HIDEABLE_TABLE_COLUMNS: Readonly<
  Record<HiddenColumnTable, readonly string[]>
> = {
  transactions: ["description", "refNumber", "tags", "attachments", "status"],
  investmentHoldings: [
    "shares",
    "avgCost",
    "price",
    "costBasis",
    "mktValue",
    "gainLoss",
    "portfolioPercent",
  ],
  investmentRegister: ["shares", "price", "status"],
};

export function isHiddenColumnTable(key: string): key is HiddenColumnTable {
  return (HIDDEN_COLUMN_TABLES as readonly string[]).includes(key);
}
