import { MnyCategory, MnyTransaction } from "../model/mny-rows";
import { MappedTag, MappedTags } from "../model/mny-import-model";
import { isClassificationItem } from "../model/mny-model";
import { MnyWarning } from "../model/mny-warnings";
import { MnyReferenceData } from "../tables/read-reference";
import { ancestorsOf } from "./map-reference";

/**
 * Money's classifications mapped onto Monize tags.
 *
 * Money offers two user-named classifications ("Classification 1" and "2":
 * a `CT` row each, `hct` 1 and 2) whose items live in `CAT` beside the
 * categories, told apart by `CAT.hct`. A transaction names at most one item of
 * each in `TRN.lHcls1` / `lHcls2`. Monize has no second categorisation axis,
 * but its tags already carry one by convention: a `key:value` name groups
 * under its key (`tag-key-value.util.ts`). So a classification becomes the
 * key and each item a value -- `Properties:20 Spring Apartment` -- and a
 * nested item keeps its path, `Properties:House:Kitchen`, which the
 * convention reads as key `Properties`, value `House:Kitchen`.
 *
 * Pure functions over typed rows, like the rest of `map/`: nothing here
 * touches the database.
 */

/** `tags.name` is `varchar(100)`. */
export const MAX_TAG_NAME_LENGTH = 100;

/** Joins a classification's name to an item path, Money's own separator. */
const TAG_PATH_SEPARATOR = ":";

/**
 * The classification items a `TRN` row carries, as `CAT` handles. Both slots
 * are read; a row with none yields an empty list, never a null slot.
 */
export function transactionTagHandles(row: MnyTransaction): number[] {
  return [row.classification1, row.classification2].filter(
    (handle): handle is number => handle !== null,
  );
}

/**
 * Item path from the top-level item down, `Parent:Child`, trimmed. An item
 * Money let be saved blank keeps a place in the path under its handle, so it
 * is still importable and still distinguishable from its siblings.
 */
function itemPath(
  item: MnyCategory,
  byHandle: ReadonlyMap<number, MnyCategory>,
): string {
  return [...ancestorsOf(item, byHandle), item]
    .map((part) => part.name.trim() || `Item ${part.handle}`)
    .join(TAG_PATH_SEPARATOR);
}

/**
 * The tag name for one item: `<classification>:<item path>`, or the path alone
 * when the file has no `CT` row for the item's classification. Clamped to the
 * column width; a name that long is already unusable as a tag.
 */
export function classificationTagName(
  item: MnyCategory,
  byHandle: ReadonlyMap<number, MnyCategory>,
  classificationName: string | undefined,
): string {
  const path = itemPath(item, byHandle);
  const key = classificationName?.trim() ?? "";
  const name = key === "" ? path : `${key}${TAG_PATH_SEPARATOR}${path}`;
  // Trimmed after the cut: `TagsService` trims what it stores, and a name that
  // came back shorter than the one asked for would not match its handle.
  return name.slice(0, MAX_TAG_NAME_LENGTH).trim();
}

/**
 * Maps the classification items that imported rows reference onto tags.
 *
 * Only referenced items become tags: a classification is a handful of values
 * and Money has no "unused" state for one, so an unreferenced item is simply
 * counted as skipped and shown as "n of m" in the preview, the way payees and
 * categories are. A referenced handle that is not a classification item in
 * `CAT` is reported, not guessed at.
 *
 * @param referenced Item handles an imported transaction, split, trade or
 *   selected bill carries.
 */
export function mapClassificationTags(
  reference: MnyReferenceData,
  referenced: ReadonlySet<number>,
): MappedTags {
  const warnings: MnyWarning[] = [];
  const byHandle = new Map(
    reference.categories
      .filter((category) => category.handle !== null)
      .map((category) => [category.handle as number, category]),
  );
  const classificationNames = new Map(
    reference.classifications
      .filter((classification) => classification.handle !== null)
      .map((classification) => [
        classification.handle as number,
        classification.name,
      ]),
  );
  const items = reference.categories.filter(
    (category) => category.handle !== null && isClassificationItem(category),
  );

  const mappedByHandle = new Map<number, MappedTag>();
  const unique = new Map<string, MappedTag>();
  let skipped = 0;

  for (const item of items) {
    const handle = item.handle as number;
    if (!referenced.has(handle)) {
      skipped += 1;
      continue;
    }
    const name = classificationTagName(
      item,
      byHandle,
      classificationNames.get(item.classification),
    );
    // Tag names are unique per user case-insensitively, so two items that
    // differ only in case become one tag and both handles map to it.
    const key = name.toLowerCase();
    const tag = unique.get(key) ?? { handle, name };
    unique.set(key, tag);
    mappedByHandle.set(handle, tag);
  }

  for (const handle of [...referenced].sort((a, b) => a - b)) {
    if (!mappedByHandle.has(handle)) {
      warnings.push({
        code: "unknownClassificationItem",
        subject: `hcat=${handle}`,
      });
    }
  }

  return {
    tags: [...unique.values()],
    byHandle: mappedByHandle,
    inFile: items.length,
    skipped,
    warnings,
  };
}
