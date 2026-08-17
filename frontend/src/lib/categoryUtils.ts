import { Category } from '@/types/category';
import type { MultiSelectOption } from '@/components/ui/MultiSelect';

interface CategoryOption {
  value: string;
  label: string;
}

/**
 * Build a hierarchical list of category options with proper indentation
 * for use in Select/Combobox components
 */
export function buildCategoryTree(
  categories: Category[],
  excludeIds: Set<string> = new Set()
): Array<{ category: Category; level: number }> {
  const buildTree = (
    parentId: string | null = null,
    level: number = 0
  ): Array<{ category: Category; level: number }> => {
    return categories
      .filter((c) => c.parentId === parentId && !excludeIds.has(c.id))
      .sort((a, b) => a.name.localeCompare(b.name))
      .flatMap((cat) => [
        { category: cat, level },
        ...buildTree(cat.id, level + 1),
      ]);
  };

  return buildTree();
}

/**
 * Convert categories to hierarchical select options
 */
export function getCategorySelectOptions(
  categories: Category[],
  options?: {
    includeEmpty?: boolean;
    emptyLabel?: string;
    excludeIds?: Set<string>;
    includeUncategorized?: boolean;
    includeTransfers?: boolean;
  }
): CategoryOption[] {
  const {
    includeEmpty = false,
    emptyLabel = 'Uncategorized',
    excludeIds = new Set<string>(),
    includeUncategorized = false,
    includeTransfers = false,
  } = options || {};

  // Build a map for quick parent lookups
  const categoryMap = new Map(categories.map((c) => [c.id, c]));

  // Get full path label for a category (e.g., "Parent: Child")
  const getFullLabel = (category: Category): string => {
    if (category.parentId) {
      const parent = categoryMap.get(category.parentId);
      if (parent) {
        return `${parent.name}: ${category.name}`;
      }
    }
    return category.name;
  };

  const tree = buildCategoryTree(categories, excludeIds);

  const categoryOptions = tree.map(({ category }) => ({
    value: category.id,
    label: getFullLabel(category),
  }));

  const result: CategoryOption[] = [];

  if (includeEmpty) {
    result.push({ value: '', label: emptyLabel });
  }

  if (includeUncategorized) {
    result.push({ value: 'uncategorized', label: 'Uncategorized' });
  }

  if (includeTransfers) {
    result.push({ value: 'transfer', label: 'Transfers' });
  }

  return [...result, ...categoryOptions];
}

/**
 * Build a map of category ID to effective (inherited) color.
 * Used by components that display categories from DB joins
 * (e.g., transaction lists, payee lists) which don't include
 * the computed effectiveColor field.
 */
export function buildCategoryColorMap(
  categories: Category[],
): Map<string, string | null> {
  return new Map(
    categories.map((c) => [c.id, c.effectiveColor ?? c.color]),
  );
}

/**
 * Build a map of category ID to its full hierarchical label
 * ("Parent: Child", or just the name for a top-level category). Useful for
 * surfaces that only hold a transaction's own category row (the list query
 * does not join the parent) but want to show the full path -- e.g. the
 * transaction action sheet.
 */
export function buildCategoryLabelMap(
  categories: Category[],
): Map<string, string> {
  const byId = new Map(categories.map((c) => [c.id, c]));
  return new Map(
    categories.map((c) => {
      const parent = c.parentId ? byId.get(c.parentId) : null;
      return [c.id, parent ? `${parent.name}: ${c.name}` : c.name];
    }),
  );
}

/**
 * Every category id in a category's subtree, itself included. The backend
 * expands descendants for its own queries; this is the client-side twin for
 * predicates that run over locally-held rows (scheduled transactions, say).
 */
export function buildDescendantIdSet(
  categories: Category[],
  categoryId: string,
): Set<string> {
  const ids = new Set<string>([categoryId]);
  let added = true;
  while (added) {
    added = false;
    for (const c of categories) {
      if (c.parentId && ids.has(c.parentId) && !ids.has(c.id)) {
        ids.add(c.id);
        added = true;
      }
    }
  }
  return ids;
}

/** One direct-child bucket of a category rollup. `name` is null for the category itself. */
export interface SubcategoryShare {
  id: string;
  name: string | null;
  total: number;
  count: number;
  /** This bucket's share of the summed absolute totals, 0..1. */
  share: number;
}

/**
 * Roll per-leaf grouped totals up to a category's direct children; rows for
 * the category itself become a bucket with `name: null` ("This category").
 * Rows outside the subtree are dropped. Shares are of the summed absolute
 * total, so mixed-sign buckets still read as parts of a whole. Returns []
 * when the category has no children -- a rollup of one bucket says nothing.
 */
export function rollupToDirectChildren(
  rows: ReadonlyArray<{ id: string | null; total: number | null; count?: number }>,
  categories: Category[],
  categoryId: string,
): SubcategoryShare[] {
  const hasChildren = categories.some((c) => c.parentId === categoryId);
  if (!hasChildren) return [];

  const parentOf = new Map(categories.map((c) => [c.id, c.parentId]));
  const rollupTarget = (id: string | null): string | null => {
    if (!id) return null;
    let current: string | null = id;
    while (current) {
      if (current === categoryId) return categoryId;
      const parent: string | null = parentOf.get(current) ?? null;
      if (parent === categoryId) return current;
      current = parent;
    }
    return null;
  };

  const buckets = new Map<string, { total: number; count: number }>();
  for (const row of rows) {
    const target = rollupTarget(row.id);
    if (!target) continue;
    // An unconvertible row (no rate for its currency) is left out of the rollup
    // rather than counted at its unconverted face value, which would size the
    // share in the wrong currency.
    if (row.total === null) continue;
    const bucket = buckets.get(target) ?? { total: 0, count: 0 };
    buckets.set(target, {
      total: bucket.total + row.total,
      count: bucket.count + (row.count ?? 0),
    });
  }
  const grandTotal = [...buckets.values()].reduce(
    (sum, bucket) => sum + Math.abs(bucket.total),
    0,
  );
  if (grandTotal === 0) return [];

  const byId = new Map(categories.map((c) => [c.id, c]));
  return [...buckets.entries()]
    .map(([id, bucket]) => ({
      id,
      name: id === categoryId ? null : (byId.get(id)?.name ?? ''),
      total: bucket.total,
      count: bucket.count,
      share: Math.abs(bucket.total) / grandTotal,
    }))
    .sort((a, b) => Math.abs(b.total) - Math.abs(a.total));
}

/**
 * The special pseudo-category filter options. Selecting "Uncategorized"
 * matches records with no category (and that are neither transfers nor
 * splits); "Transfers" matches transfer records. Shared by the Transactions
 * and Bills & Deposits filter panels.
 */
export const SPECIAL_CATEGORY_FILTER_OPTIONS: MultiSelectOption[] = [
  { value: 'uncategorized', label: 'Uncategorized' },
  { value: 'transfer', label: 'Transfers' },
];

/**
 * Build the category filter options used by the filter panels: the special
 * pseudo-options followed by the category hierarchy (parents with their
 * children nested), sorted alphabetically at each level. Selecting a parent
 * selects all of its descendants (handled by MultiSelect).
 */
export function buildCategoryFilterOptions(categories: Category[]): MultiSelectOption[] {
  const buildOptions = (parentId: string | null = null): MultiSelectOption[] =>
    categories
      .filter((c) => c.parentId === parentId)
      .sort((a, b) => a.name.localeCompare(b.name))
      .flatMap((cat) => {
        const children = buildOptions(cat.id);
        return [
          {
            value: cat.id,
            label: cat.name,
            parentId: cat.parentId,
            children: children.length > 0 ? children : undefined,
          },
        ];
      });
  return [...SPECIAL_CATEGORY_FILTER_OPTIONS, ...buildOptions()];
}

/**
 * Resolve selected category filter IDs (including the special
 * "uncategorized"/"transfer" pseudo-IDs) to Category-like records for chip
 * display.
 */
export function resolveSelectedCategories(
  categoryIds: string[],
  categories: Category[],
): Category[] {
  return categoryIds
    .map((id) => {
      if (id === 'uncategorized') return { id, name: 'Uncategorized', color: null } as Category;
      if (id === 'transfer') return { id, name: 'Transfers', color: null } as Category;
      return categories.find((c) => c.id === id);
    })
    .filter((c): c is Category => c !== undefined);
}
