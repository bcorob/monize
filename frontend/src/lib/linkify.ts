import { toSafeExternalUrl } from './external-url';

/**
 * Splits user-authored text into plain runs and the web addresses inside it.
 *
 * A transaction's description is where a receipt, a ticket or an order page
 * ends up, and until now it was rendered as inert text: the reader had to
 * select the URL and paste it somewhere. This turns the address into something
 * clickable WITHOUT changing what is stored -- the field stays plain text, the
 * `@SanitizeHtml()` decorator that strips `<` and `>` on write stays exactly as
 * it is, and nothing anywhere renders markup a user supplied. Descriptions are
 * visible to joint owners and delegates, so the one thing that must never be
 * true here is that a stored string can decide what gets rendered; the parser
 * only ever decides where to draw an anchor around text it hands back verbatim.
 *
 * The invariant that makes that checkable: concatenating every segment's `value`
 * reproduces the input exactly. Linkifying changes what a description AFFORDS,
 * never what it SAYS.
 */

export interface LinkifiedTextSegment {
  kind: 'text';
  value: string;
}

export interface LinkifiedLinkSegment {
  kind: 'link';
  /** The address as the user typed it -- what the reader sees. */
  value: string;
  /** The same address, once `toSafeExternalUrl` has vouched for the scheme. */
  href: string;
}

export type LinkifiedSegment = LinkifiedTextSegment | LinkifiedLinkSegment;

/**
 * Characters that must never reach a link's label.
 *
 * Bidi overrides and isolates (U+202A-202E, U+2066-2069) reorder what is drawn
 * without changing the string, so `https://evil.test/<U+202E>moc.knab//:sptth`
 * is one string that READS as `https://evil.test/https://bank.com` -- a label
 * whose bytes equal its `href` and whose rendering does not. Zero-width and
 * word-joiner characters hide inside a host, and C0/C1 controls have no visible
 * form at all. `@SanitizeHtml()` strips none of these: it removes `<` and `>`.
 *
 * None of them is legitimate in an address either -- RFC 3986 is ASCII, and a
 * browser percent-encodes anything else on the way out -- so a URL simply ends
 * at the first one, and the remainder stays in the prose where it can mislead
 * nobody about where a click goes.
 *
 * This does NOT address a homograph host (Cyrillic `a` in `bank.com`). That is
 * the browser's job, through the punycode rules its address bar applies, and
 * claiming it here would be a worse promise than the one this fixes.
 */
const INVISIBLE_CHARS =
  '\\u0000-\\u001F\\u007F-\\u009F\\u061C\\u200B-\\u200F\\u202A-\\u202E\\u2060-\\u2064\\u2066-\\u2069\\uFEFF\\uFFF9-\\uFFFB';

/** The same set, for asserting a candidate is clean before it becomes an href. */
const HAS_INVISIBLE = new RegExp(`[${INVISIBLE_CHARS}]`);

/**
 * An explicit scheme is required. `www.example.com` and `example.com` are left
 * as text: a bare host has to be guessed at, and a guess that is wrong renders
 * a link to somewhere the writer did not name. `<` and `>` are excluded so the
 * match cannot run past the address even in a legacy row that predates the
 * write-time sanitizer, and the invisible set above for the reason given there.
 */
const URL_CANDIDATE = new RegExp(`https?://[^\\s<>${INVISIBLE_CHARS}]+`, 'gi');

/** Closing brackets, and the opener each one balances. */
const CLOSERS: Record<string, string> = { ')': '(', ']': '[', '}': '{' };

/** Punctuation that ends a sentence rather than belonging to the address. */
const TRAILING_PUNCTUATION = new Set([
  '.', ',', ';', ':', '!', '?', "'", '"', '’', '”',
]);

function occurrences(haystack: string, needle: string): number {
  let count = 0;
  for (const character of haystack) if (character === needle) count += 1;
  return count;
}

/**
 * Drops the characters a writer put AFTER the address rather than in it.
 *
 * "tickets: https://ex.test/a." ends in a full stop, and
 * "(see https://ex.test/a)" in a bracket that closes the prose, not the URL --
 * but Wikipedia's own article titles end in a balanced ")", so a closer is only
 * shed when nothing inside the match opened it. Everything trimmed here stays
 * in the text segment that follows, which is what keeps the round trip exact.
 */
function trimTrailingPunctuation(candidate: string): string {
  let end = candidate.length;
  while (end > 0) {
    const character = candidate[end - 1];
    if (TRAILING_PUNCTUATION.has(character)) {
      end -= 1;
      continue;
    }
    const opener = CLOSERS[character];
    if (opener !== undefined) {
      const inside = candidate.slice(0, end);
      if (occurrences(inside, character) > occurrences(inside, opener)) {
        end -= 1;
        continue;
      }
    }
    break;
  }
  return candidate.slice(0, end);
}

/**
 * The address if it can be linked, otherwise null.
 *
 * `toSafeExternalUrl` is the codebase's one door from a stored string to an
 * `href`; the parse on top of it rejects the shapes that door lets through but
 * a browser would resolve oddly -- `https://` with no host at all.
 */
function hrefFor(candidate: string): string | null {
  // Belt and braces: the pattern above already ends a match at one of these, so
  // this only fires if that character class is ever loosened. The label and the
  // destination are the same string, so a character that changes how the label
  // renders is a character that makes them disagree.
  if (HAS_INVISIBLE.test(candidate)) return null;
  const safe = toSafeExternalUrl(candidate);
  if (safe === null) return null;
  try {
    return new URL(safe).hostname.length > 0 ? safe : null;
  } catch {
    return null;
  }
}

/**
 * The text, split into what to render as prose and what to render as a link.
 *
 * A candidate that is not linkable comes back as text, so an unparseable or
 * non-http address still reads exactly as the writer typed it.
 */
export function linkifySegments(text: string): LinkifiedSegment[] {
  const pieces: LinkifiedSegment[] = [];
  let cursor = 0;

  // `matchAll` reads `lastIndex` off the source pattern, so a shared global
  // regex has to be rewound or the second call over the same text answers
  // differently from the first.
  URL_CANDIDATE.lastIndex = 0;
  for (const match of text.matchAll(URL_CANDIDATE)) {
    const start = match.index;
    const candidate = trimTrailingPunctuation(match[0]);
    const href = candidate.length > 0 ? hrefFor(candidate) : null;
    // A rejected candidate leaves the cursor alone, so it stays part of the
    // prose and merges with the text either side of it below.
    if (href === null) continue;

    pieces.push({ kind: 'text', value: text.slice(cursor, start) });
    pieces.push({ kind: 'link', value: candidate, href });
    cursor = start + candidate.length;
  }
  pieces.push({ kind: 'text', value: text.slice(cursor) });

  return mergeAdjacentText(pieces);
}

/**
 * Folds the empty and neighbouring text runs together, so one run of prose is
 * always one segment however many candidates inside it were declined. Without
 * it the renderer would emit a different node shape for the same visible text.
 */
function mergeAdjacentText(pieces: LinkifiedSegment[]): LinkifiedSegment[] {
  return pieces.reduce<LinkifiedSegment[]>((accumulated, piece) => {
    if (piece.kind === 'text' && piece.value.length === 0) return accumulated;
    const previous = accumulated[accumulated.length - 1];
    if (piece.kind === 'text' && previous?.kind === 'text') {
      return [
        ...accumulated.slice(0, -1),
        { kind: 'text', value: previous.value + piece.value },
      ];
    }
    return [...accumulated, piece];
  }, []);
}
