import { EntityManager, In } from "typeorm";
import { Account } from "../accounts/entities/account.entity";
import { loadQualifiedCategoryNames } from "../categories/category-name.util";
import { Payee } from "../payees/entities/payee.entity";
import { Tag } from "../tags/entities/tag.entity";
import type { RuleReferencedIds } from "./rule-validation";

/**
 * Names for the ids a rule definition mentions, so a card or a tool result can
 * say "Groceries" where the stored rule says a UUID. Display only: nothing
 * reads a decision back from a label.
 */
export interface RuleDefinitionLabels {
  readonly accounts: Readonly<Record<string, string>>;
  readonly payees: Readonly<Record<string, string>>;
  /** Qualified ("Parent: Child"), the form a category is named to a model. */
  readonly categories: Readonly<Record<string, string>>;
  readonly tags: Readonly<Record<string, string>>;
}

export const EMPTY_RULE_LABELS: RuleDefinitionLabels = {
  accounts: {},
  payees: {},
  categories: {},
  tags: {},
};

export function mergeRuleLabels(
  ...parts: readonly RuleDefinitionLabels[]
): RuleDefinitionLabels {
  return {
    accounts: Object.assign({}, ...parts.map((p) => p.accounts)),
    payees: Object.assign({}, ...parts.map((p) => p.payees)),
    categories: Object.assign({}, ...parts.map((p) => p.categories)),
    tags: Object.assign({}, ...parts.map((p) => p.tags)),
  };
}

/**
 * Names for `ids`, scoped by `userId`. An id that is not the user's (or is
 * gone) is simply absent, so a caller falls back to showing no name rather
 * than another owner's.
 */
export async function loadRuleLabels(
  m: EntityManager,
  userId: string,
  ids: RuleReferencedIds,
): Promise<RuleDefinitionLabels> {
  const names = async (
    entity: typeof Account | typeof Payee | typeof Tag,
    wanted: readonly string[],
  ): Promise<Record<string, string>> => {
    if (wanted.length === 0) return {};
    const found = (await m.find(entity as typeof Account, {
      select: { id: true, name: true },
      where: { id: In([...wanted]), userId },
    })) as Array<{ id: string; name: string }>;
    return Object.fromEntries(found.map((row) => [row.id, row.name]));
  };
  const categories: Record<string, string> = {};
  if (ids.categoryIds.length > 0) {
    const qualified = await loadQualifiedCategoryNames(m, userId);
    for (const id of ids.categoryIds) {
      const name = qualified.get(id);
      if (name !== undefined) categories[id] = name;
    }
  }
  return {
    accounts: await names(Account, ids.accountIds),
    payees: await names(Payee, ids.payeeIds),
    categories,
    tags: await names(Tag, ids.tagIds),
  };
}
