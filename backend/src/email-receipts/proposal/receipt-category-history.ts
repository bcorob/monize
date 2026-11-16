import type { EntityManager } from "typeorm";
import { completeness } from "../parsing/parse-receipt";
import {
  isItemLine,
  type ParsedReceipt,
} from "../parsing/receipt-parser.types";

/**
 * The first source of an item's category (spec 7, "Categories"): what the user
 * already filed an item of the same name under. The order is history, then the
 * profile's `categoryRules` / default (an advanced option), then the AI for what
 * is left. History is the split memos of the user's own transactions: a receipt
 * split is stored with the item's name as the memo (`name` or `name x qty`).
 * No new table: one read through the caller's scoped manager.
 */

/** At most this many distinct item names are looked up for one receipt. */
const MAX_HISTORY_NAMES = 100;

/** The comparison key of an item name: case and runs of whitespace ignored. */
export const itemHistoryKey = (name: string): string =>
  name.toLowerCase().trim().replace(/\s+/g, " ");

/**
 * The category id the user most recently used for each item name of a receipt
 * (key `itemHistoryKey`). The query is the caller's own transaction (`m` comes
 * from `withScopedDb`), filtered by `userId`; a VOID transaction is no
 * evidence, and the quantity suffix a memo carries (` x 2`) is ignored.
 */
export async function loadItemCategoryHistory(
  m: EntityManager,
  userId: string,
  itemNames: readonly string[],
): Promise<ReadonlyMap<string, string>> {
  const keys = [
    ...new Set(itemNames.map(itemHistoryKey).filter((key) => key !== "")),
  ].slice(0, MAX_HISTORY_NAMES);
  if (keys.length === 0) return new Map();
  const rows: { key: string; category_id: string }[] = await m.query(
    `SELECT DISTINCT ON (k.key) k.key AS key, ts.category_id AS category_id
       FROM transaction_splits ts
       JOIN transactions t ON t.id = ts.transaction_id
       CROSS JOIN LATERAL (
         SELECT regexp_replace(
                  lower(btrim(regexp_replace(ts.memo, '\\s+', ' ', 'g'))),
                  ' x [0-9]+$', ''
                ) AS key
       ) k
      WHERE t.user_id = $1
        AND ts.kind = 'category'
        AND ts.category_id IS NOT NULL
        AND ts.memo IS NOT NULL
        AND t.status IS DISTINCT FROM 'VOID'
        AND k.key = ANY($2::text[])
      ORDER BY k.key, t.transaction_date DESC, ts.created_at DESC`,
    [userId, keys],
  );
  return new Map(rows.map((row) => [row.key, row.category_id]));
}

/**
 * The reading with each item's category replaced by its history, when the item
 * name has one that is still one of the user's categories (`categories`: id to
 * name); the item is marked `categorySource: "history"`. An item the history
 * does not cover keeps what the rules gave it (or none, for the AI). The
 * completeness is judged again by the shared function when the reading was
 * complete or lacked only categories; any other reason is left alone.
 */
export function applyCategoryHistory(
  parsed: ParsedReceipt,
  history: ReadonlyMap<string, string>,
  categories: ReadonlyMap<string, string>,
): ParsedReceipt {
  let changed = false;
  const items = parsed.items.map((item) => {
    // Only an item line is looked up: shipping, fee and discount lines keep their category.
    const categoryId = isItemLine(item)
      ? history.get(itemHistoryKey(item.name))
      : undefined;
    if (
      categoryId === undefined ||
      !categories.has(categoryId) ||
      categoryId === item.categoryId
    ) {
      return item;
    }
    changed = true;
    return { ...item, categoryId, categorySource: "history" as const };
  });
  if (!changed) return parsed;
  const next = { ...parsed, items };
  const rejudge =
    parsed.reason === null ||
    parsed.reason === "items_uncategorized" ||
    parsed.reason === "shipping_uncategorized";
  if (!rejudge) return next;
  const reason = completeness(next);
  return { ...next, complete: reason === null, reason };
}
