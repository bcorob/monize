/**
 * The names an expression may use for accounts, payees, categories and tags.
 * The stored tree holds ids; the text shows names, and the id never appears
 * unless the item no longer exists.
 *
 * A name that two items share is told apart by its number: `payee("Amazon", 2)`
 * is the second of the payees called Amazon, ordered by id. The number is only
 * printed when the name is shared, and it resolves back to exactly one id.
 */
import type { RuleValueKind } from '@/lib/rule-fields';
import { getCategorySelectOptions } from '@/lib/categoryUtils';
import type { Category } from '@/types/category';

export const ENTITY_KINDS = ['account', 'payee', 'category', 'tag'] as const;
export type CelEntityKind = (typeof ENTITY_KINDS)[number];

export interface CelEntity {
  readonly id: string;
  readonly name: string;
}

export type CelCatalog = Readonly<Record<CelEntityKind, readonly CelEntity[]>>;

export const EMPTY_CATALOG: CelCatalog = { account: [], payee: [], category: [], tag: [] };

/** The entity a field of this kind names, if it names one. */
export const ENTITY_KIND_OF_FIELD: Readonly<Partial<Record<RuleValueKind, CelEntityKind>>> = {
  accountId: 'account',
  payeeId: 'payee',
  categoryId: 'category',
  tagIds: 'tag',
};

export const isEntityKind = (value: string): value is CelEntityKind =>
  (ENTITY_KINDS as readonly string[]).includes(value);

/** What the lookups the editor already loaded offer, under the names a person knows. */
export function buildCatalog(lookups: {
  readonly accounts: readonly { id: string; name: string }[];
  readonly payees: readonly { id: string; name: string }[];
  readonly categories: readonly Category[];
  readonly tags: readonly { id: string; name: string }[];
}): CelCatalog {
  const pick = (list: readonly { id: string; name: string }[]): CelEntity[] =>
    list.map(({ id, name }) => ({ id, name }));
  return {
    account: pick(lookups.accounts),
    payee: pick(lookups.payees),
    // "Parent: Child", the label every category picker shows.
    category: getCategorySelectOptions([...lookups.categories]).map((o) => ({ id: o.value, name: o.label })),
    tag: pick(lookups.tags),
  };
}

/** How an item is written: its name, and its number among the items of that name when shared. */
export interface EntityName {
  readonly name: string;
  readonly ordinal: number | null;
  readonly count: number;
}

const byId = (a: CelEntity, b: CelEntity): number => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/** Two-way lookup over a catalog, built once per editor. */
export class EntityIndex {
  private readonly byName = new Map<CelEntityKind, Map<string, CelEntity[]>>();
  private readonly byIdMap = new Map<CelEntityKind, Map<string, EntityName>>();

  constructor(readonly catalog: CelCatalog = EMPTY_CATALOG) {
    for (const kind of ENTITY_KINDS) {
      const names = new Map<string, CelEntity[]>();
      for (const entity of catalog[kind]) {
        names.set(entity.name, [...(names.get(entity.name) ?? []), entity]);
      }
      const ids = new Map<string, EntityName>();
      for (const [name, group] of names) {
        const sorted = [...group].sort(byId);
        names.set(name, sorted);
        sorted.forEach((entity, i) =>
          ids.set(entity.id, { name, ordinal: sorted.length > 1 ? i + 1 : null, count: sorted.length }),
        );
      }
      this.byName.set(kind, names);
      this.byIdMap.set(kind, ids);
    }
  }

  /** Every item called `name`, ordered by id; empty when there is none. */
  find(kind: CelEntityKind, name: string): readonly CelEntity[] {
    return this.byName.get(kind)?.get(name) ?? [];
  }

  /** The written form of an id, or null when the item is not in the catalog. */
  nameOf(kind: CelEntityKind, id: string): EntityName | null {
    return this.byIdMap.get(kind)?.get(id) ?? null;
  }

  /** Every item with the way it is written, in catalog order. */
  list(kind: CelEntityKind): readonly (CelEntity & EntityName)[] {
    return this.catalog[kind].flatMap((entity) => {
      const written = this.nameOf(kind, entity.id);
      return written ? [{ ...entity, ...written }] : [];
    });
  }
}
