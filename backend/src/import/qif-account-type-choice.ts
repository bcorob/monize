import type { QifAccountBlock } from "./qif-parser";

export interface QifAccountTypeChoice {
  accountName: string;
  accountType: string;
}

/**
 * Fill the type of each account the file leaves unknown with the user's
 * choice for that name. A type the file names is kept: the choice answers a
 * question the review step asked, not a reclassification.
 */
export function applyAccountTypeChoices(
  blocks: QifAccountBlock[],
  choices: QifAccountTypeChoice[] = [],
): QifAccountBlock[] {
  const chosen = new Map(choices.map((c) => [c.accountName, c.accountType]));
  return blocks.map((block) =>
    block.accountType !== null
      ? block
      : { ...block, accountType: chosen.get(block.accountName) ?? null },
  );
}

/**
 * Names of the accounts the import would create without knowing their type.
 * A nameless block creates no account, so it needs no type.
 */
export function accountsMissingType(blocks: QifAccountBlock[]): string[] {
  return [
    ...new Set(
      blocks
        .filter((b) => b.accountName && b.accountType === null)
        .map((b) => b.accountName),
    ),
  ];
}
