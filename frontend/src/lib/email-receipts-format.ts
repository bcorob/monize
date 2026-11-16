import {
  EMAIL_RECEIPT_DISPLAY_STATES,
  EMAIL_RECEIPT_STATUSES,
  MAX_PARSER_DRAFT_DOMAINS,
  MAX_PARSER_DRAFT_EMAILS_PER_DOMAIN,
  PARSED_RECEIPT_REASONS,
  RECEIPT_LINE_KINDS,
  RECEIPT_LINK_OUTCOMES,
  type EmailReceiptDomainCount,
  type EmailReceiptListItem,
  type ParsedReceipt,
  type ParsedReceiptItem,
  type ParsedReceiptReason,
  type ReceiptLinkReport,
} from '@/types/email-receipts';
import { isRecord } from '@/lib/helpers/is-record';

/** A parsed receipt's amounts are integers in 1/10000 units (`decimal(20,4)`'s scale). */
const RECEIPT_UNITS_PER_CURRENCY_UNIT = 10_000;

/**
 * A parsed amount as an ordinary currency amount, for `formatCurrency`.
 * The one place the 1/10000 scale is undone, once per figure: dividing again
 * downstream (or dividing a figure that is already a transaction amount) is
 * a 10000x error that still renders as a plausible price.
 */
export function fromReceiptUnits(units: number): number {
  return units / RECEIPT_UNITS_PER_CURRENCY_UNIT;
}

/** A stated amount, or `null` for "the email did not say". Zero is a stated amount. */
const readAmount = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;

const readText = (value: unknown): string | null => (typeof value === 'string' && value !== '' ? value : null);

function readItem(value: unknown): ParsedReceiptItem | null {
  if (!isRecord(value) || typeof value.name !== 'string') return null;
  const amount = readAmount(value.amount);
  if (amount === null) return null;
  return {
    name: value.name,
    qty: typeof value.qty === 'number' && Number.isFinite(value.qty) ? value.qty : 1,
    amount,
    categoryId: readText(value.categoryId),
    ...(value.categorySource === 'ai' ? { categorySource: 'ai' as const } : {}),
    ...(RECEIPT_LINE_KINDS.find((kind) => kind === value.kind) ? { kind: value.kind as ParsedReceiptItem['kind'] } : {}),
    ...(readText(value.link) !== null ? { link: readText(value.link) as string } : {}),
    ...(readText(value.instalment) !== null ? { instalment: readText(value.instalment) as string } : {}),
  };
}

function readLinkReport(value: unknown): ReceiptLinkReport | null {
  if (!isRecord(value)) return null;
  const outcome = RECEIPT_LINK_OUTCOMES.find((o) => o === value.outcome);
  const partAmount = readAmount(value.partAmount);
  if (!outcome || partAmount === null) return null;
  const componentNet = readAmount(value.componentNet);
  const taken = readAmount(value.taken);
  const several = readAmount(value.several);
  const componentReason = PARSED_RECEIPT_REASONS.find((r) => r === value.componentReason);
  return {
    partIndex: readAmount(value.partIndex) ?? 0,
    link: readText(value.link),
    partAmount,
    outcome,
    componentReceiptId: readText(value.componentReceiptId),
    ...(componentNet !== null ? { componentNet } : {}),
    ...(taken !== null ? { taken } : {}),
    ...(several !== null ? { several } : {}),
    ...(componentReason ? { componentReason } : {}),
  };
}

/**
 * The stored `parsed` of a receipt as a `ParsedReceipt`, or `null` when there
 * is none. The API types it as a bare record (it is a jsonb column a newer or
 * older server may have written), so every field is read defensively: an
 * amount that is not a number is unknown, never `0`.
 */
export function readParsedReceipt(value: unknown): ParsedReceipt | null {
  if (!isRecord(value)) return null;
  const reason = PARSED_RECEIPT_REASONS.find((r) => r === value.reason) as ParsedReceiptReason | undefined;
  return {
    orderId: readText(value.orderId),
    total: readAmount(value.total),
    paid: readAmount(value.paid),
    payee: readText(value.payee),
    reference: readText(value.reference),
    shipping: readAmount(value.shipping),
    discount: readAmount(value.discount),
    items: Array.isArray(value.items)
      ? value.items.map(readItem).filter((item): item is ParsedReceiptItem => item !== null)
      : [],
    shippingCategoryId: readText(value.shippingCategoryId),
    discountCategoryId: readText(value.discountCategoryId),
    // Absent is "not a component / not a joined settlement"; an empty text is no key.
    ...(value.linkKey === null || typeof value.linkKey === 'string' ? { linkKey: readText(value.linkKey) } : {}),
    ...(Array.isArray(value.links)
      ? { links: value.links.map(readLinkReport).filter((link): link is ReceiptLinkReport => link !== null) }
      : {}),
    complete: value.complete === true,
    reason: reason ?? null,
    ...(value.source === 'ai' || value.source === 'parser' || value.source === 'schema_org' ? { source: value.source } : {}),
  };
}

/** The domain of an address (`orders@shop.example.com` gives `shop.example.com`); empty when there is none. */
export function senderDomain(fromAddress: string): string {
  const at = fromAddress.lastIndexOf('@');
  return at === -1 ? '' : fromAddress.slice(at + 1).trim().toLowerCase();
}

/** What the receipts table and the detail dialog call a stored email's state. */
export const EMAIL_RECEIPT_SHOWN_STATES = [
  ...EMAIL_RECEIPT_STATUSES.filter((status) => status !== 'review'),
  ...EMAIL_RECEIPT_DISPLAY_STATES,
] as const;
export type EmailReceiptShownState = (typeof EMAIL_RECEIPT_SHOWN_STATES)[number];

/**
 * The state to show for an email. A `review` email is told apart by what its
 * request says (`displayState`: waiting for approval, applied, dismissed, ...);
 * every other status is its own state. A `review` email the server sent with no
 * display state is shown as `request_missing`, never as a proposal waiting.
 */
export function shownReceiptState(receipt: Pick<EmailReceiptListItem, 'status' | 'displayState'>): EmailReceiptShownState {
  if (receipt.status !== 'review') return receipt.status;
  return receipt.displayState ?? 'request_missing';
}

/** Whether a person can still change what the email proposes (it is neither closed nor applied). */
export function isReceiptActionable(receipt: Pick<EmailReceiptListItem, 'status' | 'displayState'>): boolean {
  return receipt.status !== 'skipped' && receipt.status !== 'ignored' && receipt.displayState !== 'applied';
}

/** The `status_reason` of a trade email already in the ledger when it arrived, and of one a person linked. */
export const RECEIPT_TRADE_EXISTS_REASON = 'trade_exists';
export const RECEIPT_TRADE_LINKED_REASON = 'trade_linked';

/**
 * Whether "Reprocess" is offered for an email: one a person can still change
 * (`isReceiptActionable`), and a trade email closed because the ledger already
 * held the trade (`ignored` as `trade_exists`), which the server reads again
 * (`refuseUnprocessable` in the pipeline) so a trade entered by mistake can be
 * proposed after all.
 */
export function canReprocessReceipt(receipt: Pick<EmailReceiptListItem, 'status' | 'statusReason' | 'displayState'>): boolean {
  if (receipt.status === 'pending') return false;
  return isReceiptActionable(receipt) || (receipt.status === 'ignored' && receipt.statusReason === RECEIPT_TRADE_EXISTS_REASON);
}

/**
 * Whether a trade email can be linked to the investment transaction it reports:
 * exactly the server's own refusals (`EmailReceiptTradeLinkService.link`), and
 * nothing stricter, so a candidate the dialog lists always has its Link button.
 * Refused: an email no profile read (the AI reads it, so there is no reading and
 * no candidate), a skipped one, one whose proposal was applied, and one that
 * already accounts for a row it was linked to or booked (only a `trade_exists`
 * email may be pointed at the right row instead).
 */
export function canLinkTradeEmail(
  receipt: Pick<EmailReceiptListItem, 'isTrade' | 'tradeSource' | 'status' | 'statusReason' | 'displayState' | 'investmentTransaction'>,
): boolean {
  if (!receipt.isTrade || receipt.tradeSource === 'ai') return false;
  if (receipt.status === 'skipped' || receipt.displayState === 'applied') return false;
  // A linked email whose row is not known (a server that predates the summary) is taken to account for it.
  if (receipt.statusReason === RECEIPT_TRADE_LINKED_REASON && receipt.investmentTransaction !== null) return false;
  return !receipt.investmentTransaction || receipt.statusReason === RECEIPT_TRADE_EXISTS_REASON;
}

/** The states from which "Recognize with AI" is offered: nothing read it, or what read it was dismissed or lost. */
const RECOGNIZABLE_STATES: readonly EmailReceiptShownState[] = [
  'no_parser',
  'parse_failed',
  'unmatched',
  'ambiguous',
  'review_conflict',
  'dismissed',
  'expired',
  'request_missing',
];

/**
 * Whether the button "Recognize with AI" is offered for an email. Whatever the
 * mailbox's AI mode (it governs only what happens by itself; pressing the button
 * is the person's consent). An email with an applied request, an ignored or a
 * skipped one, one still waiting to be read and one whose proposal is waiting
 * for approval or for an agent gets no button.
 */
export function canRecognizeWithAi(receipt: Pick<EmailReceiptListItem, 'status' | 'displayState'>): boolean {
  return RECOGNIZABLE_STATES.includes(shownReceiptState(receipt));
}

/** States whose email "Draft parser with AI" is offered for: no parser read it, the one that did could not, or it is a component (a profile can be edited). */
const DRAFTABLE_STATES: readonly EmailReceiptShownState[] = ['no_parser', 'parse_failed', 'component'];

/** Whether the row's own "Draft parser with AI" action is offered for an email. */
export function canDraftParser(receipt: Pick<EmailReceiptListItem, 'status' | 'displayState'>): boolean {
  return DRAFTABLE_STATES.includes(shownReceiptState(receipt));
}

/** What a "Draft parser with AI" request asks for (`kind` of `POST /email-receipt-parsers/draft-with-ai`). */
export type ParserDraftKind = 'receipt' | 'trade';

/**
 * The kind of profile some emails are drafted into: a trade profile when every
 * one is a trade confirmation, a receipt profile when none is, and `mixed` (no
 * request can be made) when they are some of each, since one profile reads one kind.
 */
export function parserDraftKind(receipts: ReadonlyArray<Pick<EmailReceiptListItem, 'isTrade'>>): ParserDraftKind | 'mixed' {
  const trades = receipts.filter((receipt) => receipt.isTrade).length;
  if (trades === 0) return 'receipt';
  return trades === receipts.length ? 'trade' : 'mixed';
}

/**
 * The distinct sender domains of some emails, in the order they first appear.
 * An email with no usable domain (a skipped one) is left out.
 */
export function distinctSenderDomains(receipts: ReadonlyArray<Pick<EmailReceiptListItem, 'fromDomain' | 'fromAddress'>>): string[] {
  const seen = new Set<string>();
  for (const receipt of receipts) {
    const domain = receipt.fromDomain || senderDomain(receipt.fromAddress);
    if (domain !== '') seen.add(domain);
  }
  return [...seen];
}

/** How many of some emails come from each sender domain, in the order the domains first appear. */
export function senderDomainCounts(
  receipts: ReadonlyArray<Pick<EmailReceiptListItem, 'fromDomain' | 'fromAddress'>>,
): { domain: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const receipt of receipts) {
    const domain = receipt.fromDomain || senderDomain(receipt.fromAddress);
    if (domain !== '') counts.set(domain, (counts.get(domain) ?? 0) + 1);
  }
  return [...counts].map(([domain, count]) => ({ domain, count }));
}

/** Why "Prepare a profile with AI" is off for a selection, or `null` when it is on. */
export type DraftBlock =
  | 'tooManyPerDomain'
  | 'tooManyDomains'
  | 'tradeOneDomain'
  | 'skipped'
  | 'mixedKinds'
  | 'allMatching';

/**
 * Whether a selection can be drafted from: one to `MAX_PARSER_DRAFT_DOMAINS` sender
 * domains with one to `MAX_PARSER_DRAFT_EMAILS_PER_DOMAIN` emails each (the server's
 * bounds), none of them unreadable (a skipped email has no text to write a profile
 * from). A trade draft takes one domain. `allMatching` is a selection by filter, not
 * a list of emails a profile could be read from. The first reason that applies is
 * the one returned. A selection over several domains is allowed, but the caller
 * confirms it first (`distinctSenderDomains(selected).length > 1`).
 */
export function draftBlock(
  selected: ReadonlyArray<Pick<EmailReceiptListItem, 'status' | 'fromDomain' | 'fromAddress' | 'isTrade'>>,
  allMatching: boolean,
): DraftBlock | null {
  if (allMatching) return 'allMatching';
  const domains = senderDomainCounts(selected);
  if (domains.some((entry) => entry.count > MAX_PARSER_DRAFT_EMAILS_PER_DOMAIN)) return 'tooManyPerDomain';
  if (domains.length > MAX_PARSER_DRAFT_DOMAINS) return 'tooManyDomains';
  if (selected.some((receipt) => receipt.status === 'skipped')) return 'skipped';
  // One profile reads one kind of email: trade confirmations and order emails are never drafted together.
  const kind = parserDraftKind(selected);
  if (kind === 'mixed') return 'mixedKinds';
  if (kind === 'trade' && domains.length > 1) return 'tradeOneDomain';
  return null;
}

/** Tags counted before a text with no `<html` or doctype is still taken for HTML. */
const HTML_TAG_THRESHOLD = 5;
/** Only this much of a text is scanned, and a tag is at most this long. */
const HTML_SCAN_CHARS = 200_000;
const HTML_TAG_MAX_CHARS = 500;

const isTagStart = (ch: string): boolean => (ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') || ch === '/' || ch === '!';

/**
 * Whether stored text is really markup: it opens with `<html` or a doctype, or it
 * holds several tags. An email whose HTML part was not kept (stored before it was)
 * can still have markup in its text when the sender put HTML in a text part; the
 * detail dialog then shows it through the same sandboxed frame as a real HTML part
 * instead of as a wall of angle brackets.
 *
 * One bounded scan, no regular expression over the text: a tag is a `<` followed by
 * a letter, `/` or `!` and a `>` within 500 characters with no other `<` between,
 * and not an address in angle brackets (`<alice@example.com>`).
 */
export function looksLikeHtml(text: string): boolean {
  const head = text.trimStart().slice(0, 20).toLowerCase();
  if (head.startsWith('<html') || head.startsWith('<!doctype')) return true;
  const end = Math.min(text.length, HTML_SCAN_CHARS);
  let tags = 0;
  let i = 0;
  while (i < end && tags < HTML_TAG_THRESHOLD) {
    if (text[i] === '<' && isTagStart(text.charAt(i + 1))) {
      const limit = Math.min(end, i + HTML_TAG_MAX_CHARS);
      let j = i + 1;
      let hasAt = false;
      let hasSpace = false;
      while (j < limit && text[j] !== '>' && text[j] !== '<') {
        if (text[j] === '@') hasAt = true;
        if (text[j] === ' ' || text[j] === '\n' || text[j] === '\t') hasSpace = true;
        j += 1;
      }
      // `<alice@example.com>` is an address in angle brackets, not a tag.
      if (j < limit && text[j] === '>' && !(hasAt && !hasSpace)) {
        tags += 1;
        i = j + 1;
        continue;
      }
    }
    i += 1;
  }
  return tags >= HTML_TAG_THRESHOLD;
}

/**
 * The sender domain most of the emails share, the first one named winning a tie:
 * the same choice the server makes when it files a "Draft parser with AI" request
 * (`dominantSenderDomain`), so the message names the domain the request carries.
 * Empty when no email has a usable domain.
 */
export function dominantSenderDomain(receipts: ReadonlyArray<Pick<EmailReceiptListItem, 'fromDomain' | 'fromAddress'>>): string {
  const counts = new Map<string, number>();
  for (const receipt of receipts) {
    const domain = receipt.fromDomain || senderDomain(receipt.fromAddress);
    if (domain !== '') counts.set(domain, (counts.get(domain) ?? 0) + 1);
  }
  let best = '';
  let bestCount = 0;
  for (const [domain, count] of counts) {
    if (count > bestCount) {
      best = domain;
      bestCount = count;
    }
  }
  return best;
}

/** A sender domain the list filter accepts: a dotted host name (the server's own shape). */
const DOMAIN_FILTER = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;

/**
 * The sender domain a `?domain=` value names, as the list filter uses it:
 * trimmed and lower-cased, or `''` (no filter) for anything that is not a host
 * name, so a mistyped or hostile query value never becomes a request the
 * server would refuse.
 */
export function normalizeDomainFilter(raw: string | null | undefined): string {
  const domain = (raw ?? '').trim().toLowerCase().replace(/^@+/, '').replace(/\.+$/, '');
  return domain.length <= 253 && DOMAIN_FILTER.test(domain) ? domain : '';
}

/**
 * How many stored emails "Process all" would run for these sender domains: the
 * `processable` of every sender domain that is one of them or a sub-domain of one
 * (the same reach a domain filter has). A server that predates `processable` is
 * read as "all of them", never as zero.
 */
export function processableForDomains(
  domains: ReadonlyArray<Pick<EmailReceiptDomainCount, 'domain' | 'count' | 'processable'>>,
  fromDomains: readonly string[],
): number {
  const wanted = fromDomains.map((domain) => domain.trim().toLowerCase()).filter((domain) => domain !== '');
  return domains
    .filter((entry) => wanted.some((domain) => entry.domain === domain || entry.domain.endsWith(`.${domain}`)))
    .reduce((sum, entry) => sum + (entry.processable ?? entry.count), 0);
}
