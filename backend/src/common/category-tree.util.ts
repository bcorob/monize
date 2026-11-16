import { Repository } from "typeorm";
import { Category } from "../categories/entities/category.entity";

/**
 * The category-filter pseudo-ids that name a whole category type. A filter
 * carrying one of them selects every category whose `isIncome` matches, so
 * a client never enumerates a type's ids (a few hundred UUIDs overflow the
 * request line and the page URL). Resolved here, in the one helper every
 * category predicate expands its ids through, so no predicate site knows
 * about them.
 */
export const CATEGORY_TYPE_FILTER_IDS = ["income", "expense"] as const;
export type CategoryTypeFilterId = (typeof CATEGORY_TYPE_FILTER_IDS)[number];

function isCategoryTypeFilterId(id: string): id is CategoryTypeFilterId {
  return (CATEGORY_TYPE_FILTER_IDS as readonly string[]).includes(id);
}

/**
 * Resolves a list of category IDs to include all their descendant categories.
 * Used by transaction filtering to include sub-categories when filtering by
 * parent. A type pseudo-id ("income" / "expense") resolves to every category
 * of that type.
 */
export async function getAllCategoryIdsWithChildren(
  categoriesRepository: Repository<Category>,
  userId: string,
  categoryIds: string[],
): Promise<string[]> {
  const categories = await categoriesRepository.find({
    where: { userId },
    select: ["id", "parentId", "isIncome"],
  });

  const result = new Set<string>();
  const addWithChildren = (parentId: string) => {
    result.add(parentId);
    for (const cat of categories) {
      if (cat.parentId === parentId && !result.has(cat.id)) {
        addWithChildren(cat.id);
      }
    }
  };

  for (const id of categoryIds) {
    if (isCategoryTypeFilterId(id)) {
      const wantIncome = id === "income";
      for (const cat of categories) {
        if (cat.isIncome === wantIncome) addWithChildren(cat.id);
      }
    } else {
      addWithChildren(id);
    }
  }

  return [...result];
}
