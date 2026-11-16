import type { RegisterColumnId } from '@/components/transactions/register-columns';

/**
 * The table kinds whose inessential columns a user can hide. Each is a key of
 * this browser's choices (`useHiddenColumnsStore`) and of the account-level
 * `hiddenTableColumns` preference (`user_preferences.hidden_table_columns`),
 * the default a browser with no choice of its own follows; one set per kind is
 * read everywhere that table is mounted.
 */
export const HIDDEN_COLUMN_TABLES = [
  'transactions',
  'investmentHoldings',
  'investmentRegister',
] as const;

export type HiddenColumnTable = (typeof HIDDEN_COLUMN_TABLES)[number];

/**
 * The hideable column ids of each table kind, in the table's display order;
 * every other column is structural and always rendered. The backend declares
 * the same lists and its contract spec parses this literal, so it stays an
 * `as const` object literal of quoted ids. The `satisfies` clause pins the
 * keys to `HIDDEN_COLUMN_TABLES` and the register's ids to `RegisterColumnId`.
 */
export const HIDEABLE_COLUMNS = {
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
} as const satisfies Record<HiddenColumnTable, readonly string[]> & {
  transactions: readonly RegisterColumnId[];
};

export type HideableColumn<T extends HiddenColumnTable> =
  (typeof HIDEABLE_COLUMNS)[T][number];

/**
 * The wire shape of the preference, and of this browser's choices. Every key
 * is optional (an absent kind means no choice, so the next fallback applies)
 * and the ids are untrusted on read: `hiddenColumnsFor` drops any it does not
 * know.
 */
export type HiddenTableColumns = Partial<Record<HiddenColumnTable, string[]>>;

function isHideable<T extends HiddenColumnTable>(
  table: T,
  id: unknown,
): id is HideableColumn<T> {
  return (HIDEABLE_COLUMNS[table] as readonly unknown[]).includes(id);
}

/** Known ids only, deduplicated, in the table kind's canonical order. */
function canonical<T extends HiddenColumnTable>(
  table: T,
  ids: Iterable<unknown>,
): HideableColumn<T>[] {
  const wanted = new Set(ids);
  return (HIDEABLE_COLUMNS[table] as readonly HideableColumn<T>[]).filter((id) =>
    wanted.has(id),
  );
}

/**
 * The hidden columns of one table kind. Tolerates a missing map, a missing or
 * malformed entry and ids this client does not know (a newer client's, or a
 * column since made structural); never throws.
 */
export function hiddenColumnsFor<T extends HiddenColumnTable>(
  map: HiddenTableColumns | null | undefined,
  table: T,
): HideableColumn<T>[] {
  const stored: unknown = map?.[table];
  if (!Array.isArray(stored)) return [];
  return canonical(table, stored.filter((id) => isHideable(table, id)));
}

/** The columns not hidden, in the order given. */
export function visibleColumns<C extends string>(
  columns: readonly C[],
  hidden: ReadonlySet<string> | readonly string[],
): C[] {
  const set: ReadonlySet<string> = hidden instanceof Set ? hidden : new Set(hidden);
  return columns.filter((id) => !set.has(id));
}

/**
 * A new map with one table kind's hidden list replaced; the list is
 * deduplicated and put in the kind's canonical order, so a duplicate or an
 * unknown id cannot leave the client. The other kinds are kept as they are.
 */
export function withHiddenColumns<T extends HiddenColumnTable>(
  map: HiddenTableColumns | null | undefined,
  table: T,
  hidden: Iterable<HideableColumn<T>>,
): HiddenTableColumns {
  return { ...(map ?? {}), [table]: canonical(table, hidden) };
}
