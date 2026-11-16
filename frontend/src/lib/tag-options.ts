import type { MultiSelectOption } from '@/components/ui/MultiSelect';
import type { Tag, TagUsageMap } from '@/types/tag';

/** How many recently used tags lead a picker before the A-Z list. */
export const RECENT_TAG_COUNT = 8;

const byName = (a: Tag, b: Tag) =>
  a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });

/** Newest first. `YYYY-MM-DD` orders as plain text, so no locale collation. */
const byDateDesc = (a: string, b: string) => (a < b ? 1 : a > b ? -1 : 0);

/**
 * Options for a picker that applies tags to a transaction (components reach
 * it through `useTagPickerOptions`): the `RECENT_TAG_COUNT` tags used most
 * recently (latest transaction date, then most uses, then name), a group
 * rule, then every other tag A-Z. Nothing is
 * dropped, so a finished project's tag still turns up when searched for; it
 * just stops sitting at the top. MultiSelect keeps this order while filtering,
 * so a search lists recent matches first, and drops the rule while searching.
 * Without usage (none recorded, or the lookup failed) the list is plain A-Z.
 */
export function buildTagOptions(tags: Tag[], usage: TagUsageMap): MultiSelectOption[] {
  const recent = tags
    .filter((tag) => usage[tag.id])
    .sort((a, b) =>
      byDateDesc(usage[a.id].lastUsed, usage[b.id].lastUsed) ||
      usage[b.id].count - usage[a.id].count ||
      byName(a, b))
    .slice(0, RECENT_TAG_COUNT);

  const recentIds = new Set(recent.map((tag) => tag.id));
  const rest = tags.filter((tag) => !recentIds.has(tag.id)).sort(byName);

  return [
    ...recent.map((tag, index) => ({
      value: tag.id,
      label: tag.name,
      separatorAfter: index === recent.length - 1 && rest.length > 0,
    })),
    ...rest.map((tag) => ({ value: tag.id, label: tag.name })),
  ];
}
