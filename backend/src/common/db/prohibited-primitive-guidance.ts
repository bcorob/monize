import { escapeRegExp } from "../escape-regexp.util";

/**
 * Classifier for "does this instruction text *recommend* a prohibited database
 * primitive", separated from the spec that scans the live documents so it can be
 * tested against fixed positive and negative examples.
 *
 * Scanning the live files proves only that today's wording passes. The first
 * version of this check was written that way, matched only prohibited *call*
 * forms, and therefore did not fire on the exact historical sentence it existed
 * to prevent -- "must use a `QueryRunner` transaction" names a type, not a call.
 * Requiring the call form had been a deliberate fix for the opposite mistake
 * (`transaction` is ordinary English in these files: "MUST run in a single
 * transaction"), so both halves are needed: call forms *and* type names, with the
 * type names limited to identifiers that are never ordinary prose.
 */

/** Prohibited type/decorator names. Never ordinary English, so safe to match bare. */
export const PROHIBITED_TYPE_NAMES = ["QueryRunner", "InjectRepository"];

/**
 * Wording that turns a mention into a recommendation. `use` is included, which
 * on its own would be far too broad -- the negation check below is what makes it
 * safe, and every real negative sentence in these files carries one.
 */
const RECOMMENDING =
  /\b(?:must|should|shall|always|prefer(?:red|ably)?|use|using|required?|recommend(?:ed)?|need to|have to)\b/i;

/**
 * Wording that marks the same mention as prohibitive or historical. Checked
 * across the whole window and taking precedence: "Never inject a repository with
 * `@InjectRepository`, call `createQueryRunner()`, ... or use a bare
 * `dataSource.query(...)`" contains `use`, and is the opposite of a
 * recommendation.
 */
const NEGATING =
  /\b(?:never|not|no|non|without|instead of|rather than|avoid(?:ed)?|prohibit\w*|reject\w*|ban(?:s|ned)?|forbid\w*|obsolete|superseded|deprecat\w*|no longer|used to|removed|wrong|bypass\w*)\b/i;

/** Characters either side of a match that the verdict is drawn from. */
const WINDOW = 160;

export interface ProhibitedGuidanceHit {
  /** The prohibited token as written. */
  token: string;
  /** The surrounding text the verdict was drawn from. */
  excerpt: string;
}

/**
 * Every place `text` reads as a recommendation to use a prohibited primitive.
 *
 * @param callNames method names banned by `no-restricted-syntax`, e.g.
 *   `createQueryRunner`, `transaction`. Matched only in call form (`name(`),
 *   because `transaction` alone is a noun these documents use constantly.
 * @param typeNames identifiers safe to match bare (`PROHIBITED_TYPE_NAMES`).
 */
export function findProhibitedGuidance(
  text: string,
  callNames: string[],
  typeNames: string[] = PROHIBITED_TYPE_NAMES,
): ProhibitedGuidanceHit[] {
  const alternatives = [
    ...callNames.map((name) => `${escapeRegExp(name)}\\(`),
    ...typeNames.map(escapeRegExp),
  ];
  if (alternatives.length === 0) return [];
  const pattern = new RegExp(`(?:${alternatives.join("|")})`, "g");

  const hits: ProhibitedGuidanceHit[] = [];
  for (const match of text.matchAll(pattern)) {
    const at = match.index ?? 0;
    const excerpt = text.slice(
      Math.max(0, at - WINDOW),
      at + match[0].length + WINDOW,
    );
    // Prohibitive or historical framing wins: these files legitimately name
    // every banned primitive in order to ban it.
    if (NEGATING.test(excerpt)) continue;
    if (!RECOMMENDING.test(excerpt)) continue;
    hits.push({ token: match[0], excerpt: excerpt.trim() });
  }
  return hits;
}
