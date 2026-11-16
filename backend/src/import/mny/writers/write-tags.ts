import { EntityManager } from "typeorm";
import { TransactionTag } from "../../../tags/entities/transaction-tag.entity";
import { TransactionSplitTag } from "../../../tags/entities/transaction-split-tag.entity";
import { MAX_TAGS_PER_CALL, TagsService } from "../../../tags/tags.service";
import { MappedTag } from "../model/mny-import-model";
import { INSERT_CHUNK_SIZE, chunk } from "./chunk";

/**
 * Writer for the tags Money's classifications become, and for the links that
 * put them on the imported rows.
 *
 * Tags are find-or-create by name through `TagsService.findOrCreateByNames`,
 * the one implementation of that (its `WHERE NOT EXISTS` plus the unique index
 * `idx_tags_user_name` is what makes a second import merge instead of
 * duplicating or failing). The links go in as chunked multi-row inserts after
 * the rows they point at exist, the same shape as `writeTransactions`.
 */

/** The slice of `TagsService` this writer needs, so a spec can double it. */
export type TagFinder = Pick<
  TagsService,
  "findByNames" | "findOrCreateByNames"
>;

export interface WrittenTags {
  /** Classification item handle (`CAT.hcat`) -> Monize tag id. */
  readonly idByHandle: ReadonlyMap<number, string>;
  /** Tags that did not exist before this import. */
  readonly created: number;
}

export async function writeTags(
  manager: EntityManager,
  tags: TagFinder,
  userId: string,
  mapped: readonly MappedTag[],
): Promise<WrittenTags> {
  const idByHandle = new Map<number, string>();
  if (mapped.length === 0) {
    return { idByHandle, created: 0 };
  }

  const names = [...new Set(mapped.map((tag) => tag.name))];
  const existing = new Set(
    (await tags.findByNames(manager, userId, names)).map((tag) =>
      tag.name.toLowerCase(),
    ),
  );

  const idByName = new Map<string, string>();
  // `findOrCreateByNames` takes at most MAX_TAGS_PER_CALL names per call.
  for (const batch of chunk(names, MAX_TAGS_PER_CALL)) {
    for (const tag of await tags.findOrCreateByNames(manager, userId, batch)) {
      idByName.set(tag.name.toLowerCase(), tag.id);
    }
  }

  for (const tag of mapped) {
    const id = idByName.get(tag.name.toLowerCase());
    if (id !== undefined) {
      idByHandle.set(tag.handle, id);
    }
  }

  return {
    idByHandle,
    created: [...idByName.keys()].filter((name) => !existing.has(name)).length,
  };
}

/** The tag ids a row's classification handles resolve to, de-duplicated. */
export function tagIdsFor(
  handles: readonly number[],
  idByHandle: ReadonlyMap<number, string>,
): string[] {
  return [
    ...new Set(
      handles
        .map((handle) => idByHandle.get(handle))
        .filter((id): id is string => id !== undefined),
    ),
  ];
}

export interface TagLink {
  readonly rowId: string;
  readonly tagId: string;
}

/** Links tags to transactions that already exist. Returns the links written. */
export async function writeTransactionTagLinks(
  manager: EntityManager,
  links: readonly TagLink[],
): Promise<number> {
  const repo = manager.getRepository(TransactionTag);
  for (const batch of chunk(links, INSERT_CHUNK_SIZE)) {
    await repo.insert(
      batch.map((link) => ({ transactionId: link.rowId, tagId: link.tagId })),
    );
  }
  return links.length;
}

/** Links tags to split legs that already exist. Returns the links written. */
export async function writeSplitTagLinks(
  manager: EntityManager,
  links: readonly TagLink[],
): Promise<number> {
  const repo = manager.getRepository(TransactionSplitTag);
  for (const batch of chunk(links, INSERT_CHUNK_SIZE)) {
    await repo.insert(
      batch.map((link) => ({
        transactionSplitId: link.rowId,
        tagId: link.tagId,
      })),
    );
  }
  return links.length;
}
