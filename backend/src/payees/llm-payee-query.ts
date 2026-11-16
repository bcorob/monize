import type { Payee } from "./entities/payee.entity";

/**
 * What the AI Assistant and the MCP `list_payees` tool may ask for.
 *
 * Declared once, here, because both tool layers are thin adapters over
 * `PayeesService.getLlmPayees` and a filter offered by one and not the other is
 * how the two surfaces drift.
 *
 * Every `has*` flag is three-valued on purpose: `true` keeps only the payees
 * carrying that detail, `false` keeps only those missing it, and omitting it
 * asks nothing. "Which payees still have no email?" and "which have one?" are
 * the same question in opposite directions, and both are worth asking.
 */
export interface LlmPayeeQuery {
  /** Case-insensitive substring of the payee name. */
  search?: string;
  /** Which payees to consider. Defaults to `all`. */
  status?: "active" | "inactive" | "all";
  sortBy?: "name" | "lastUsed" | "transactionCount";
  /** Maximum rows to return. The result reports whether it truncated. */
  limit?: number;
  hasWebsite?: boolean;
  hasLogo?: boolean;
  hasAddress?: boolean;
  hasEmail?: boolean;
  hasPhone?: boolean;
  hasDefaultCategory?: boolean;
}

/** A payee row with the figures `findAll` derives. */
export type LlmPayeeRow = Payee & {
  transactionCount: number;
  lastUsedDate: string | null;
  aliasCount: number;
  uncategorizedCount: number;
};

export interface LlmPayeeList {
  payees: LlmPayeeRow[];
  /** How many payees matched the filters, before any limit was applied. */
  totalCount: number;
  /** True when `payees` is a page of `totalCount`, not the whole of it. */
  truncated: boolean;
}
