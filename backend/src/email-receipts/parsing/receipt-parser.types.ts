/**
 * The types of the email-receipt parser (design 5). Pure data: no behaviour,
 * no database, no clock. Every amount a parser reads is a non-negative
 * integer in 1/10000 units (spec section 1), the unit rule facts use.
 */

/**
 * The only definition version this code reads or writes. Version 1 (one line
 * pattern per field, first matching line wins) was replaced by this one before
 * any parser used it: a stored version 1 definition is invalid and is saved
 * again, never read with another rule.
 */
export const RECEIPT_PARSER_VERSION = 2;

/** Design 5.2: bounds the validator enforces and the parser relies on. */
export const MAX_PATTERNS_PER_FIELD = 10;
export const MAX_PATTERN_LENGTH = 200;
export const MAX_CATEGORY_RULES = 50;
export const MAX_SECTION_MARKER_LENGTH = 100;
/** Consecutive lines one multi-line pattern (parts joined by `\n`) may span. */
export const MAX_PATTERN_LINES = 5;
/** Parsing reads at most this many lines of an email. */
export const MAX_PARSE_LINES = 2000;
/** Parsing keeps at most this many line items. */
export const MAX_ITEMS = 100;
/** A line is cut to this many characters (the glob matcher's own bound). */
export const MAX_LINE_LENGTH = 500;
/** The lines a labelled field looks at after its label (bounds and default). */
export const MIN_LABEL_WITHIN = 1;
export const MAX_LABEL_WITHIN = 10;
export const DEFAULT_LABEL_WITHIN = 3;
/** Lines a block item section drops, and steps of one record. */
export const MAX_SKIP_LINES = 10;
export const MAX_RECORD_STEPS = 6;
/** Alternative globs one record step may list. */
export const MAX_STEP_ALTERNATIVES = 5;
/** Globs one of `requireLine`, `skipIfLine` and `waitIfLine` may list. */
export const MAX_LINE_GUARDS = 10;
/** Lines a `joinWrapped` item section holds back for the next line. */
export const MAX_JOINED_LINES = 3;
/** A traced line is cut to this many characters. */
export const MAX_TRACE_LINE_LENGTH = 200;
/** The longest tag a profile may add to the transactions it splits. */
export const MAX_PROFILE_TAG_LENGTH = 50;
/** The longest category name a profile may give (`defaultCategory`, `shippingCategory`, `feesCategory`). */
export const MAX_PROFILE_CATEGORY_NAME_LENGTH = 100;
/** The largest `balanceTolerance`, in 1/10000 units: `0.05`. */
export const MAX_BALANCE_TOLERANCE_UNITS = 500;
/** Linked receipts (spec "linked receipts" 2.2): the default and largest `link.daysBefore`. */
export const DEFAULT_LINK_DAYS_BEFORE = 120;
export const MAX_LINK_DAYS_BEFORE = 365;
/** Days after a settlement's date that a component may still be dated (a gateway notice and a shop email cross). */
export const LINK_DAYS_AFTER = 7;
/** The longest link value, once whitespace is removed. */
export const MAX_LINK_VALUE_LENGTH = 100;
/** The longest `{instalment}` text; a longer one is cut. */
export const MAX_INSTALMENT_TEXT_LENGTH = 50;
/** The most sender domains `link.fromDomains` may list. */
export const MAX_LINK_DOMAINS = 10;

/** The item section and the patterns that read one line item per line. */
export interface ReceiptItemsDefinition {
  /** Case-insensitive substring: items start on the line AFTER the first line holding it. */
  startAfter?: string;
  /** Case-insensitive substring: items end BEFORE the first line holding it after the start. */
  stopAt?: string;
  patterns: string[];
  /**
   * A line no pattern reads is held (up to 3) and put in front of the next line;
   * when the whole buffer does not make a readable line, a shorter one is tried
   * (the last 2, 1, then 0 held lines).
   */
  joinWrapped?: boolean;
}

/**
 * A category for every item the rule covers: `field` "item" (the default) when
 * the glob matches the item's name, "payee" when it matches the parsed payee,
 * "line" when it matches any line of the email (the last two cover every item).
 */
export interface ReceiptCategoryRule {
  match: string;
  categoryId: string;
  field?: ReceiptCategoryRuleField;
}

/**
 * A field entry that finds its value NEAR a label line. `label` is a
 * capture-free glob matched against a whole line; `value` is the field's own
 * pattern, tried on each of the next `within` lines (default 3).
 */
export interface ReceiptLabelledPattern {
  label: string;
  value: string;
  within?: number;
}

/** A field entry is a line pattern or a labelled one. */
export type ReceiptFieldEntry = string | ReceiptLabelledPattern;

/**
 * One line of a record. `line` is a glob, or a list of alternative globs tried
 * in order (the first that matches and reads wins). An optional step that does
 * not match consumes nothing.
 */
export interface ReceiptRecordStep {
  line: string | string[];
  optional?: boolean;
}

/** One item for the whole email: its name from the first line the glob matches. */
export interface ReceiptSingleItemDefinition {
  name: string;
}

/**
 * Items that span several lines. `skipLines` globs drop lines from
 * the section first; then `record` is read from a cursor, one item per match.
 */
export interface ReceiptBlockItemsDefinition {
  startAfter?: string;
  stopAt?: string;
  skipLines?: string[];
  record: ReceiptRecordStep[];
}

/** One item that carries the whole amount (a payment gateway's one-line notice). */
export interface ReceiptSingleItemsDefinition {
  startAfter?: string;
  stopAt?: string;
  single: ReceiptSingleItemDefinition;
}

/** Where a category rule looks: the item's name, the parsed payee, or any line of the email. */
export type ReceiptCategoryRuleField = "item" | "payee" | "line";

/**
 * Which rendering of the email a parser reads its lines from: the stored text
 * (`"text"`, the default) or the lines of the HTML part (`"html"`, one line per
 * block element and per table cell; `imap/html-lines.util.ts`). Every pattern,
 * guard and trace line number refers to the chosen source.
 */
export type ReceiptLinesSource = "text" | "html";
export const RECEIPT_LINES_SOURCES: readonly ReceiptLinesSource[] = [
  "text",
  "html",
];

/**
 * How a profile identifies the bank transaction an email paid for, in the order
 * the profile lists them (design 5.5, spec 3a): `reference` and `orderId` look
 * for the parsed value in the transaction's text, `amount_payee` is an amount
 * within the tolerance plus a payee signal, `amount_date` an amount within the
 * tolerance inside the date window.
 */
export type ReceiptMatchStrategy =
  "reference" | "orderId" | "amount_payee" | "amount_date";
export const RECEIPT_MATCH_STRATEGIES: readonly ReceiptMatchStrategy[] = [
  "reference",
  "orderId",
  "amount_payee",
  "amount_date",
];

/** The transaction fields a `reference` or `orderId` strategy looks in. */
export type ReceiptMatchTextField = "description" | "payee" | "referenceNumber";
export const RECEIPT_MATCH_TEXT_FIELDS: readonly ReceiptMatchTextField[] = [
  "description",
  "payee",
  "referenceNumber",
];

/**
 * The `match` section of a profile: every key is optional and the defaults
 * reproduce the matching a profile without the section had (spec 3a).
 * `amountTolerance` is a decimal string (`"0.00"` to `"5.00"`) because it is
 * money: it is compared in 1/10000 units, never as a float.
 */
export interface ReceiptMatchDefinition {
  by?: ReceiptMatchStrategy[];
  referenceIn?: ReceiptMatchTextField[];
  daysBefore?: number;
  daysAfter?: number;
  amountTolerance?: string;
}

/**
 * What a profile's emails are for (linked receipts): `standalone` (the default)
 * is read as one receipt that finds its bank transaction; a `component` holds
 * the detail of a purchase and waits for a settlement; a `settlement` names the
 * bank transaction and its items are parts that may point at components.
 */
export type ReceiptParserRole = "standalone" | "component" | "settlement";
export const RECEIPT_PARSER_ROLES: readonly ReceiptParserRole[] = [
  "standalone",
  "component",
  "settlement",
];

/**
 * The `link` section of a settlement profile: where and how far back its parts
 * look for their components. Every key is optional.
 */
export interface ReceiptLinkDefinition {
  /** 1 to 10 sender domains the component search is limited to; absent means any sender. */
  fromDomains?: string[];
  /** 0 to 365, default 120: how many days before the settlement's date a component may be dated. */
  daysBefore?: number;
}

/** The most account rules a trade section may hold. */
export const MAX_TRADE_ACCOUNT_RULES = 20;
/** The most currency markers a trade section may hold. */
export const MAX_TRADE_CURRENCY_MARKERS = 20;
/** The most decimals a share quantity may have (the `investment_transactions.quantity` scale). */
export const MAX_TRADE_QUANTITY_DECIMALS = 8;

/**
 * Which brokerage account a trade email is for: the first rule whose glob
 * matches the text the `account` entries read wins; `defaultAccountId` covers
 * the rest. The ids are UUIDs of the user's INVESTMENT accounts; ownership and
 * type are checked when the proposal is built, in the proposal's transaction.
 * A rule with a `currency` applies only to a trade in that currency, so two
 * accounts the broker prints alike (an RRSP in CAD and one in USD) are told
 * apart; a trade whose currency cannot be told reads no account.
 */
export interface ReceiptTradeAccountRule {
  match: string;
  accountId: string;
  /** A 3-letter ISO code; absent means any currency. */
  currency?: string;
}

/**
 * A text that names the trade's currency somewhere in the email ("*US$*",
 * "*U.S. dollars*"): a capture-free glob tried on every line, markers in array
 * order. Consulted when the amounts name no currency themselves.
 */
export interface ReceiptTradeCurrencyMarker {
  match: string;
  /** A 3-letter ISO code. */
  currency: string;
}

/**
 * The `trade` section of a profile (trade-confirmation emails, a brokerage's
 * "your order has been filled"): the email is read as ONE investment
 * transaction to create, not as a purchase paid from a bank transaction. Every
 * field is a list of entries read exactly like the receipt fields (a line
 * pattern or a labelled `{label, value, within}`); the capture each takes is in
 * brackets. `symbol`, `action` and one of `total`/`price` are required;
 * `quantity`, `commission`, `date` and `account` are optional. A buy, a sell
 * or a reinvested dividend still needs its share count when the email is read
 * (`trade_no_quantity`); a cash dividend needs none.
 */
export interface ReceiptTradeDefinition {
  /** The words that say the direction: `{action}` is searched for "buy", "sell", "dividend" or "reinvest". */
  action: ReceiptFieldEntry[];
  /** The ticker as the broker writes it: `{symbol}`. */
  symbol: ReceiptFieldEntry[];
  /** The number of shares, fractions allowed: `{quantity}`; a cash dividend needs none. */
  quantity?: ReceiptFieldEntry[];
  /** The executed total, the fact (commission included for a buy; a dividend's amount paid): `{amount}`. */
  total?: ReceiptFieldEntry[];
  /** The average price per share (a dividend's amount per share), a cross-check and the fallback to the total: `{amount}`. */
  price?: ReceiptFieldEntry[];
  /** The commission, when the email states one: `{amount}`. */
  commission?: ReceiptFieldEntry[];
  /** The day of the trade, `YYYY-MM-DD` or "October 15, 2026" (time ignored): `{date}`; else the email's day. */
  date?: ReceiptFieldEntry[];
  /** The account text the broker prints (for `accountRules`): `{account}`. */
  account?: ReceiptFieldEntry[];
  accountRules?: ReceiptTradeAccountRule[];
  defaultAccountId?: string;
  /** Texts that name the currency when the amounts do not (for currency rules). */
  currencyMarkers?: ReceiptTradeCurrencyMarker[];
}

/**
 * A per-merchant parser (the `definition` jsonb of `email_receipt_parsers`).
 * A field's entries are tried in array order; an entry is a line pattern or a
 * labelled `{label, value, within}`; items are one per line (`patterns`) or a
 * multi-line `record`.
 */
export interface ReceiptParserDefinition {
  version: 2;
  /** The lines the parser reads: the email's text (default) or its HTML part. */
  source?: ReceiptLinesSource;
  orderId?: ReceiptFieldEntry[];
  total?: ReceiptFieldEntry[];
  /** The amount actually paid (after a discount); `total` is then the list price. */
  paid?: ReceiptFieldEntry[];
  shipping?: ReceiptFieldEntry[];
  /**
   * Further charges (a deposit, packing, delivery): EVERY entry that finds an
   * accepted amount is one fee, and the fees are summed. Gross is items plus
   * shipping plus fees; each fee is its own split line under `feesCategoryId`.
   */
  fees?: ReceiptFieldEntry[];
  discount?: ReceiptFieldEntry[];
  /** The merchant, when it is not the sender (a payment gateway). Capture `{payee}`. */
  payee?: ReceiptFieldEntry[];
  /**
   * An identifier the shop or the payment gateway puts into the bank operation
   * (the card statement line, a transfer title). Capture `{reference}`; the
   * `reference` match strategy looks for it in the transaction's text.
   */
  reference?: ReceiptFieldEntry[];
  /** How the transaction this email paid for is identified (design 5.5). */
  match?: ReceiptMatchDefinition;
  /** What the profile's emails are for; absent is `standalone`. */
  role?: ReceiptParserRole;
  /**
   * A `component` only: the key that ties the email to a settlement (a contract
   * number). Capture `{link}`; the value is stored without whitespace, lower case.
   */
  linkKey?: ReceiptFieldEntry[];
  /** A `settlement` only: where its parts look for their components. */
  link?: ReceiptLinkDefinition;
  /**
   * A tag the proposal adds to every transaction this profile splits (created
   * when missing, at confirm time). 1 to 50 characters, trimmed.
   */
  tag?: string;
  /**
   * Ask the user's AI for the category of an item no rule categorised, when it
   * can answer now; otherwise queue the request for an agent (design 5.6).
   */
  aiCategories?: boolean;
  items?:
    | ReceiptItemsDefinition
    | ReceiptBlockItemsDefinition
    | ReceiptSingleItemsDefinition;
  categoryRules?: ReceiptCategoryRule[];
  defaultCategoryId?: string;
  shippingCategoryId?: string;
  feesCategoryId?: string;
  /**
   * The same categories by NAME (1 to 100 characters): the server replaces a
   * name by the user's category id when the profile is saved; the engine only
   * validates the text.
   */
  defaultCategory?: string;
  shippingCategory?: string;
  feesCategory?: string;
  /**
   * The difference between the lines and the stated total or paid amount that
   * is still a balanced receipt: a decimal text `"0.00"` to `"0.05"` (integer
   * 1/10000 arithmetic). The proposal adds the difference to its last split line.
   */
  balanceTolerance?: string;
  /**
   * A trade confirmation (see {@link ReceiptTradeDefinition}). A profile with
   * this section reads nothing else: it holds no receipt field, item or match
   * section (`trade_conflict`).
   */
  trade?: ReceiptTradeDefinition;
  /** The parser applies only when a line matches one of these; else the next parser for the domain. */
  requireLine?: string[];
  /** A line matching one of these makes the receipt `ignored` (`skip_line`). */
  skipIfLine?: string[];
  /** A line matching one of these leaves the receipt `unmatched` (`wait_line`) for a later re-read. */
  waitIfLine?: string[];
  /**
   * The profile's emails are never read: every email the pipeline gives this
   * profile is ignored or deleted (see {@link RECEIPT_DISCARD_MODES}), before
   * any guard or field. For senders whose mail is never wanted.
   */
  discard?: ReceiptDiscardMode;
}

/**
 * What a profile does with the emails it matches instead of reading them:
 * `ignore` marks each one `ignored` (`profile_ignore`), `delete` removes it.
 */
export const RECEIPT_DISCARD_MODES = ["ignore", "delete"] as const;
export type ReceiptDiscardMode = (typeof RECEIPT_DISCARD_MODES)[number];

/**
 * What a split line is (linked receipts 4.1): an `item` (the default), the
 * `shipping` or a `fee` of a joined component, or its `discount`. A `discount`
 * line keeps a non-negative amount and counts against the total.
 */
export type ReceiptLineKind = "item" | "shipping" | "fee" | "discount";

/** True for an item line: a line without `kind` is one (a receipt stored before `kind` existed). */
export const isItemLine = (item: { kind?: ReceiptLineKind }): boolean =>
  item.kind === undefined || item.kind === "item";

/** One line item as read from the email. */
export interface ParsedReceiptItem {
  name: string;
  qty: number;
  /** The line total, in 1/10000 units. */
  amount: number;
  categoryId: string | null;
  /**
   * `"ai"` when the AI chose this item's category (design 5.6); absent when a
   * rule, the default or the payee did. The card and the receipt page label it.
   */
  categorySource?: "ai" | "history";
  /** What the line is; absent is `item`. Only a joined component's lines carry another kind. */
  kind?: ReceiptLineKind;
  /** A settlement part's link value (capture `{link}`, normalized); absent otherwise. */
  link?: string;
  /** A settlement part's instalment text (capture `{instalment}`, at most 50 characters); absent otherwise. */
  instalment?: string;
}

/** The first thing missing from a receipt that is not complete (spec section 4). */
export type ParsedReceiptReason =
  | "no_total"
  | "no_items"
  | "item_amount_missing"
  | "items_unbalanced"
  | "items_uncategorized"
  | "shipping_uncategorized";

/** What a settlement part became (linked receipts 4.2); `RECEIPT_LINK_OUTCOMES` is the list a CHECK constraint holds. */
export type ReceiptLinkOutcome =
  | "no_link"
  | "not_found"
  | "component_incomplete"
  | "component_used"
  | "joined"
  | "scaled"
  | "amount_exceeds";
export const RECEIPT_LINK_OUTCOMES: readonly ReceiptLinkOutcome[] = [
  "no_link",
  "not_found",
  "component_incomplete",
  "component_used",
  "joined",
  "scaled",
  "amount_exceeds",
];

/** The report of one settlement part, stored in the joined receipt's `links`. Amounts are 1/10000 units. */
export interface ReceiptLinkReport {
  partIndex: number;
  /** The part's link value; null when it captured none. */
  link: string | null;
  partAmount: number;
  outcome: ReceiptLinkOutcome;
  /** The component found; null when none was. */
  componentReceiptId: string | null;
  /** The component's net (its lines, discount subtracted). */
  componentNet?: number;
  /** What other settlements already took from the component. */
  taken?: number;
  /** How many components the link found (more than one: a resend). */
  several?: number;
  /** Why an incomplete component is incomplete. */
  componentReason?: ParsedReceiptReason | null;
}

/**
 * What a parser read from one email. Amounts are 1/10000 units. `total`,
 * `shipping` and `discount` are null when the email did not state them.
 *
 * `shippingCategoryId` and `discountCategoryId` are the categories the
 * proposal gives the shipping and discount lines; they are resolved here, from
 * the definition, so the proposal builder needs no definition.
 */
export interface ParsedReceipt {
  orderId: string | null;
  total: number | null;
  /** What was actually paid; null when the email did not state it (and on a receipt stored before it existed). */
  paid: number | null;
  /** The merchant the email names; null when it names none. */
  payee: string | null;
  /**
   * The identifier the profile's `reference` field read (what the shop put into
   * the bank operation); null or absent when none (and on a receipt stored
   * before it existed).
   */
  reference?: string | null;
  /**
   * A component's link value (normalized `linkKey` capture); null when a
   * component's email holds none. Absent on every other receipt and on a
   * receipt stored before it existed.
   */
  linkKey?: string | null;
  shipping: number | null;
  /** Each fee the profile's `fees` entries read, in 1/10000 units, in entry order; absent on a receipt stored before fees existed. */
  fees?: number[];
  discount: number | null;
  items: ParsedReceiptItem[];
  shippingCategoryId: string | null;
  /** The category of every fee line; null or absent when none. */
  feesCategoryId?: string | null;
  /** 1/10000 units: what the lines may differ from the stated amounts by and still balance; absent is 0. */
  balanceTolerance?: number;
  discountCategoryId: string | null;
  /** A joined settlement only: one report per part; absent on every other receipt. */
  links?: ReceiptLinkReport[];
  complete: boolean;
  reason: ParsedReceiptReason | null;
  /**
   * Who read the email: a saved parser (absent, as every receipt stored before
   * this field existed), the AI (`"ai"`, spec "AI extraction") or the email's
   * own structured data (`"schema_org"`, spec "Structured data"). It changes
   * nothing about the completeness rules or the proposal; it tells the reader
   * where the figures came from.
   */
  source?: "parser" | "ai" | "schema_org";
}

/** A line a trace points at: its 1-based number among the email's lines (0 is the subject) and its text. */
export interface ReceiptTraceLine {
  line: number;
  text: string;
}

/** What found one value: the entry of the field, its glob and the line that produced it. */
export interface ReceiptTraceHit {
  /** Index in the field's list (a guard's list too). */
  entry: number;
  /** The line glob; for a labelled entry, its `value` glob. */
  pattern: string;
  /** A labelled entry's `label` glob and the line it matched. */
  label?: string;
  labelLine?: ReceiptTraceLine;
  /** The line the value was read from; for a multi-line pattern, the first line it matched. */
  line: ReceiptTraceLine;
  /** A multi-line pattern: every line it matched, first to last (absent for a one-line match). */
  lines?: ReceiptTraceLine[];
}

/** What read one item: the glob(s) and the line(s) that produced it. */
export interface ReceiptTraceItem {
  mode: "patterns" | "record" | "single";
  /** The item's glob (patterns, single) or, for a record, the glob of each line in `lines` (a multi-line step's glob once per line it took). */
  patterns: string[];
  /** The lines the item was read from (a joined item lists each of them). */
  lines: ReceiptTraceLine[];
}

/** Why a parser read what it read: for the `test` operation and the editor's test panel. */
export interface ReceiptTrace {
  orderId: ReceiptTraceHit | null;
  reference: ReceiptTraceHit | null;
  /** A component's `linkKey` hit; absent on other profiles. */
  linkKey?: ReceiptTraceHit | null;
  total: ReceiptTraceHit | null;
  paid: ReceiptTraceHit | null;
  shipping: ReceiptTraceHit | null;
  /** One hit per `fees` entry that read an amount. */
  fees?: ReceiptTraceHit[];
  discount: ReceiptTraceHit | null;
  payee: ReceiptTraceHit | null;
  requireLine: ReceiptTraceHit | null;
  skipIfLine: ReceiptTraceHit | null;
  waitIfLine: ReceiptTraceHit | null;
  items: ReceiptTraceItem[];
}

/**
 * What a trade email reports, the only four the pipeline creates: a buy, a
 * sell, a cash dividend (no shares move) and a reinvested dividend (shares
 * bought with the distribution, no cash moves).
 */
export const PARSED_TRADE_ACTIONS = [
  "BUY",
  "SELL",
  "DIVIDEND",
  "REINVEST",
] as const;
export type ParsedTradeAction = (typeof PARSED_TRADE_ACTIONS)[number];

/** Whether a trade action moves shares, so its reading needs a share count. */
export const tradeActionMovesShares = (action: ParsedTradeAction): boolean =>
  action !== "DIVIDEND";

/** The first thing missing from a trade that is not complete. */
export type ParsedTradeReason =
  | "trade_no_action"
  | "trade_no_symbol"
  | "trade_no_quantity"
  | "trade_no_amount"
  | "trade_no_account"
  | "trade_no_currency";

/** Where a trade's currency was read: the amounts, a currency marker, or the user's security. */
export type ParsedTradeCurrencySource = "amount" | "marker" | "security";

/**
 * What a `trade` profile read from one email. `quantity` is a share count with
 * at most 8 decimals; `total`, `price` and `commission` are non-negative
 * integers in 1/10000 units; `date` is `YYYY-MM-DD`. `consistent` says whether
 * quantity times price agrees with the executed total (price rounding and one
 * cent allowed): null when the email does not state all three, so there is
 * nothing to cross-check. `complete` means the email stated everything a
 * proposal needs; only a complete reading that is consistent (or, for a cash
 * dividend, not inconsistent) can auto-apply.
 */
export interface ParsedTrade {
  action: ParsedTradeAction | null;
  symbol: string | null;
  quantity: number | null;
  total: number | null;
  price: number | null;
  /**
   * The price as written, in 1e-8 units (a decimal string, since JSON has no
   * BigInt). `price` is its 4-decimal card value; a price-only total is derived
   * from this one. Absent on a reading stored before it existed.
   */
  priceUnits8?: string | null;
  commission: number | null;
  /**
   * The trade's currency as a 3-letter code: the one the total (else the
   * price) names unambiguously ("USD 2,000.00", "US$2,000.00"; a bare `$`
   * names none), else the first currency marker that matches a line, else
   * (only when an account rule needs it) the currency of the user's security
   * for the ticker. An email-read currency is checked against the security's
   * when the card is built.
   */
  currency?: string | null;
  currencySource?: ParsedTradeCurrencySource | null;
  /** The trade's day, else null (the proposal then uses the email's day). */
  date: string | null;
  /** The account text the email printed, when the profile reads one. */
  accountText: string | null;
  /** The account the profile's rules (or its default) chose; null when none applies. */
  accountId: string | null;
  complete: boolean;
  consistent: boolean | null;
  reason: ParsedTradeReason | null;
}

/** Why a trade profile read what it read, for the `test` operation. */
export interface ReceiptTradeTrace {
  action: ReceiptTraceHit | null;
  symbol: ReceiptTraceHit | null;
  quantity: ReceiptTraceHit | null;
  total: ReceiptTraceHit | null;
  price: ReceiptTraceHit | null;
  commission: ReceiptTraceHit | null;
  date: ReceiptTraceHit | null;
  account: ReceiptTraceHit | null;
  /** The currency marker that named the currency (`entry` indexes `currencyMarkers`). */
  currency: ReceiptTraceHit | null;
}
