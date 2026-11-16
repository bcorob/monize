import {
  ConflictException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { isUUID } from "class-validator";
import { DataSource, EntityManager, In, QueryDeepPartialEntity } from "typeorm";
import { AiReviewRequestsService } from "../../ai-review/ai-review-requests.service";
import { loadQualifiedCategoryNames } from "../../categories/category-name.util";
import { returnedRows } from "../../common/db/query-result";
import { withScopedDb } from "../../common/db/scoped-db";
import { roundMoney } from "../../common/round.util";
import { tr } from "../../i18n/translate";
import {
  toParserView,
  type EmailReceiptParserView,
} from "./email-receipt-parser.view";
import { Payee } from "../../payees/entities/payee.entity";
import { PayeesService } from "../../payees/payees.service";
import {
  EmailReceiptParser,
  EMAIL_RECEIPT_PARSER_MAX_FROM_DOMAINS,
  EMAIL_RECEIPT_PARSER_MAX_SUBJECT_WORDS,
} from "../entities/email-receipt-parser.entity";
import { EmailReceipt } from "../entities/email-receipt.entity";
import {
  EMAIL_RECEIPT_PARSER_LANGUAGE_GUIDE,
  EMAIL_RECEIPT_PARSER_TOOL_MAX_DRAFTS,
  EMAIL_RECEIPT_PARSER_TOOL_MAX_RECEIPTS,
} from "./parser-tool.guide";
import {
  checkComponentDrafts,
  createDraftComponentReader,
  type ComponentDraft,
} from "./component-draft";
import { effectiveMatchDefinition } from "../parsing/receipt-match-config";
import { resolveParserCategoryNames } from "./parser-category-names.util";
import type {
  ReceiptLinkOutcome,
  ReceiptLineKind,
  ReceiptMatchStrategy,
  ReceiptTraceHit,
} from "../parsing/receipt-parser.types";
import type { ReceiptOutcome } from "../parsing/parse-receipt";
import {
  compareWithExpected,
  dryRunReceipt,
  loadTransactionSummaries,
  type ExpectedAgreement,
} from "./receipt-dry-run";
import {
  RECEIPT_PARSER_VERSION,
  type ParsedReceipt,
  type ParsedTrade,
  type ParsedTradeAction,
  type ReceiptParserDefinition,
  type ReceiptTrace,
  type ReceiptTradeTrace,
} from "../parsing/receipt-parser.types";
import {
  collectParserAccountIds,
  collectParserCategoryIds,
  validateReceiptParserDefinition,
  type ReceiptParserValidationError,
} from "../parsing/receipt-parser.validation";
import {
  isReceiptDomain,
  normalizeReceiptDomain,
} from "./dto/receipt-domain.validator";
import { MAX_PARSERS_PER_USER } from "./email-receipt-parsers.service";
import {
  assertParserReferencesOwned,
  usableTradeAccountIds,
  invalidDefinitionError,
} from "./parser-references.util";

/**
 * The `email_receipt_parsers` tool's logic (the assistant's executor and the MCP
 * tool are thin adapters over it, `docs/backend/ai-and-payees.md` "Shared AI
 * tools"): everything an agent needs to write a receipt parser from stored
 * emails, and nothing that touches the ledger or reads mail.
 *
 * - `listCategories`: the category ids a parser names, with qualified names.
 * - `testDefinition`: read stored emails with a definition that is not saved and
 *   report what it parsed. Reads only.
 * - `saveDraft`: store the definition as a DRAFT parser (`status: draft`,
 *   `source: ai`). A draft reads no email until the user approves it, so this is
 *   not a write to anything that moves money (INV-RECEIPT-003); the user's
 *   approval in the settings screen is the confirmation.
 *
 * Every read and write is keyed on `userId` (the JWT's, or the MCP context's),
 * never on an argument: an email or category that is not the user's reads as
 * absent.
 */

/** Categories one `categories` call returns. */
export const PARSER_TOOL_MAX_CATEGORIES = 300;
/** Emails one `test` call reads (the same bound a draft request has: 5 per sender, 2 senders). */
export const PARSER_TOOL_MAX_RECEIPTS = EMAIL_RECEIPT_PARSER_TOOL_MAX_RECEIPTS;

const MONEY_UNITS = 10_000;
const MAX_NAME_LENGTH = 100;
const MAX_SUBJECT_WORD_LENGTH = 100;

/** A parsed receipt as a model reads it: decimal amounts, category names. */
export interface LlmParsedReceipt {
  orderId: string | null;
  /** What the profile's `reference` field read; null when none. */
  reference: string | null;
  /** A component's link value; present only on a component's reading. */
  linkKey?: string | null;
  total: number | null;
  paid: number | null;
  payee: string | null;
  shipping: number | null;
  discount: number | null;
  items: Array<{
    name: string;
    qty: number;
    amount: number;
    category: string | null;
    /** A settlement part's link value and instalment text; present only when read. */
    link?: string;
    instalment?: string;
    /** A joined component's line that is not an item (`shipping`, `fee`, `discount`); absent for an item. */
    kind?: ReceiptLineKind;
  }>;
  complete: boolean;
  reason: ParsedReceipt["reason"];
}

/**
 * What a trade profile read from one tested email, in the units a model reads:
 * shares, decimal money. `consistent` null means the email does not state the
 * shares, the price and the total, so there is nothing to cross-check.
 */
export interface LlmParsedTrade {
  action: ParsedTradeAction | null;
  symbol: string | null;
  quantity: number | null;
  total: number | null;
  price: number | null;
  commission: number | null;
  /** The trade's currency ("USD"): its amounts', else a marker's, else the security's; null when none says. */
  currency: string | null;
  currencySource: "amount" | "marker" | "security" | null;
  date: string | null;
  accountText: string | null;
  accountId: string | null;
  complete: boolean;
  consistent: boolean | null;
  reason: string | null;
}

/**
 * What the profile's matching would do with one tested email, compactly: the
 * strategy that decided, the transaction it matched, how many candidates each
 * strategy kept (spec 3a). Reads only.
 */
export interface ParserToolMatch {
  /** `component`: a component profile's email is stored, never matched to a transaction. */
  outcome: "matched" | "ambiguous" | "unmatched" | "component";
  /** The strategy that matched or found several candidates; null when none did. */
  strategy: ReceiptMatchStrategy | null;
  transaction: {
    id: string;
    date: string;
    amount: number;
    payeeName: string | null;
  } | null;
  /** Candidates inside the profile's date window. */
  considered: number;
  attempts: Array<{ strategy: ReceiptMatchStrategy; count: number }>;
}

/**
 * One part of a tested settlement email (linked receipts spec 10), in decimal
 * units: the link it captured, the component that link found, and what the
 * join did with the part.
 */
export interface ParserToolLink {
  partIndex: number;
  link: string | null;
  /** The component found (the newest of several); null when none. */
  component: {
    receiptId: string;
    subject: string;
    /** `YYYY-MM-DD`. */
    effectiveDate: string;
    profileName: string | null;
    /** `draft`: read with the test's `componentDrafts`; `stored`: the receipt as the pipeline stored it. */
    source: "stored" | "draft";
  } | null;
  partAmount: number;
  /** The component's net; null when it was not measured (no component, or an incomplete one). */
  componentNet: number | null;
  /** What other settlements already took from the component; null when not measured. */
  taken: number | null;
  /** What the join did with the part: `joined`, `scaled`, `not_found`, `component_incomplete`, `component_used`, `amount_exceeds` or `no_link`. */
  outcome: ReceiptLinkOutcome;
  /** How many components the link found. */
  several: number;
}

export interface ParserToolTestEmail {
  receiptId: string;
  subject: string;
  /** ISO timestamp: the day the shop sent the order, or the day the email arrived. */
  effectiveDate: string;
  parsed: LlmParsedReceipt;
  /** `read`, or the guard that stops the pipeline reading this email under the parser. */
  outcome: ReceiptOutcome;
  /** Which entry and which line read each value; at most 20 items are traced. */
  trace: ReceiptTrace;
  /** What the definition's `match` section would do with this email (design 5.5). A settlement is matched as its joined reading. */
  match: ParserToolMatch;
  /** A component profile only: the link value it read and the trace hit that read it. */
  linkKey?: { value: string | null; hit: ReceiptTraceHit | null };
  /** A component profile only: settlement emails whose link rows wait for this key (newest first, at most 20); a settlement is re-read when the component is stored. */
  waitingSettlements?: Array<{
    receiptId: string;
    subject: string;
    /** `YYYY-MM-DD`. */
    date: string;
  }>;
  /** A settlement profile only: one entry per part; `parsed.items` are then the joined lines. At most 20 are listed. */
  links?: ParserToolLink[];
  /** For a trade profile: what it read and which line read each value. Such a profile has no bank match, and `parsed` is empty. */
  trade?: { parsed: LlmParsedTrade; trace: ReceiptTradeTrace };
  /**
   * The transaction the caller says this email paid for and whether the parsed
   * date and total agree with it; null when the sample named none.
   */
  expected: {
    transactionId: string;
    date: string;
    amount: number;
    currencyCode: string;
    payeeName: string | null;
  } | null;
  agreement: ExpectedAgreement | null;
}

/** One sample of a `test` call: an email, and optionally the transaction it paid for. */
export interface ParserToolSample {
  receiptId: string;
  transactionId?: string;
}

/** Items a `test` result traces (the rest are counted in `parsed`). */
const TRACE_MAX_ITEMS = 20;

export interface ParserToolTestResult {
  /** False when the definition failed validation; `errors` says where and why. */
  valid: boolean;
  errors: ReceiptParserValidationError[];
  /** Category ids the definition names that are not the user's. */
  unknownCategoryIds: string[];
  /** Account ids a trade profile names that are not an open brokerage account of the user's. */
  unknownAccountIds: string[];
  emails: ParserToolTestEmail[];
  /**
   * Present when the call carried `componentDrafts`: true when the call's read
   * limit (`MAX_DRAFT_COMPONENT_READS` stored emails) left emails the drafts
   * cover unread, so a part reported `not_found` may still have a component.
   */
  componentDraftsExhausted?: boolean;
  /** True only when the definition is valid and every email reads complete. */
  allComplete: boolean;
  /**
   * Whether every sample that named an expected transaction agrees with it on
   * date and total; null when no sample named one.
   */
  allAgree: boolean | null;
}

export interface ParserToolCategories {
  categories: Array<{ id: string; name: string }>;
  totalCount: number;
  truncated: boolean;
  /** The user's investment accounts (id, name and currency), for a trade profile's `accountRules` and `defaultAccountId`. */
  investmentAccounts: Array<{ id: string; name: string; currencyCode: string }>;
  /** The whole parser language, which the tool's description has no room for. */
  guide: string;
}

/** One saved parser in the `get` list: enough to pick one, and read it with its id. */
export interface ParserToolSummary {
  id: string;
  name: string;
  fromDomains: string[];
  subjectContains: string[];
  status: EmailReceiptParser["status"];
  source: EmailReceiptParser["source"];
  revision: number;
  definitionValid: boolean;
  updatedAt: string;
}

/** One saved parser in full: the view a person's editor reads, plus the payee's name. */
export type ParserToolDetail = Omit<
  EmailReceiptParserView,
  "reprocessableCount"
> & {
  payeeName: string | null;
};

/** An unsaved component profile offered beside a settlement under test (spec 10a). */
export interface ParserToolComponentDraft {
  definition: unknown;
  fromDomains: readonly string[];
}

export interface ParserToolSaveInput {
  /** The claimed parser-draft request this draft answers, when there is one. */
  requestId?: string;
  /**
   * Update this DRAFT parser instead of creating one; `expectedRevision` is then
   * required and must still be the draft's revision (compare-and-swap under the
   * row lock). An approved parser is never changed by the tool.
   */
  parserId?: string;
  expectedRevision?: number;
  name: string;
  fromDomains: string[];
  subjectContains?: string[];
  /** Resolved with the payee lookup the other tools use; never created. */
  payeeName?: string;
  definition: unknown;
}

export interface ParserToolSaveResult {
  parserId: string;
  name: string;
  status: "draft";
  /** The draft's revision after this save (1 for a new draft). */
  revision: number;
  fromDomains: string[];
  /** The payee the name resolved to, or null when none did (nothing is created). */
  payee: { id: string; name: string } | null;
  /** The matching the saved profile effectively has (defaults filled in); null for a trade profile, which matches no bank transaction. */
  match: ReturnType<typeof effectiveMatchDefinition> | null;
  /** True when the request named by `requestId` is now `proposed`. */
  requestProposed: boolean;
}

/** A model may leave the version out; it has still written a parser of the current version. */
function withVersion(definition: unknown): unknown {
  return typeof definition === "object" &&
    definition !== null &&
    !Array.isArray(definition)
    ? {
        version: RECEIPT_PARSER_VERSION,
        ...(definition as Record<string, unknown>),
      }
    : definition;
}

const units = (value: number | null): number | null =>
  value === null ? null : roundMoney(value / MONEY_UNITS);

function toLlmParsed(
  parsed: ParsedReceipt,
  categoryNames: ReadonlyMap<string, string>,
): LlmParsedReceipt {
  return {
    orderId: parsed.orderId,
    reference: parsed.reference ?? null,
    ...(parsed.linkKey === undefined ? {} : { linkKey: parsed.linkKey }),
    total: units(parsed.total),
    paid: units(parsed.paid ?? null),
    payee: parsed.payee ?? null,
    shipping: units(parsed.shipping),
    discount: units(parsed.discount),
    items: parsed.items.map((item) => ({
      name: item.name,
      qty: item.qty,
      amount: roundMoney(item.amount / MONEY_UNITS),
      category:
        item.categoryId === null
          ? null
          : (categoryNames.get(item.categoryId) ?? null),
      ...(item.link === undefined ? {} : { link: item.link }),
      ...(item.instalment === undefined ? {} : { instalment: item.instalment }),
      ...(item.kind === undefined || item.kind === "item"
        ? {}
        : { kind: item.kind }),
    })),
    complete: parsed.complete,
    reason: parsed.reason,
  };
}

function toLlmTrade(trade: ParsedTrade): LlmParsedTrade {
  return {
    action: trade.action,
    symbol: trade.symbol,
    quantity: trade.quantity,
    total: units(trade.total),
    price: units(trade.price),
    commission: units(trade.commission),
    currency: trade.currency ?? null,
    currencySource: trade.currencySource ?? null,
    date: trade.date,
    accountText: trade.accountText,
    accountId: trade.accountId,
    complete: trade.complete,
    consistent: trade.consistent,
    reason: trade.reason,
  };
}

@Injectable()
export class EmailReceiptParserToolsService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly payees: PayeesService,
    private readonly requests: AiReviewRequestsService,
  ) {}

  /**
   * The user's categories as `id` and qualified name (`Parent: Child`), for a
   * parser's `categoryRules`, `defaultCategoryId` and `shippingCategoryId`. At
   * most `PARSER_TOOL_MAX_CATEGORIES`; `truncated` says more exist.
   */
  async listCategories(userId: string): Promise<ParserToolCategories> {
    const names = await withScopedDb(this.dataSource, (m) =>
      loadQualifiedCategoryNames(m, userId),
    );
    const all = [...names.entries()];
    const accounts = await withScopedDb(this.dataSource, async (m) =>
      returnedRows<{ id: string; name: string; currencyCode: string }>(
        await m.query(
          `SELECT id, name, currency_code AS "currencyCode"
             FROM accounts
            WHERE user_id = $1
              AND account_type = 'INVESTMENT'
              AND account_sub_type IS DISTINCT FROM 'INVESTMENT_CASH'
              AND is_closed = false
            ORDER BY name ASC
            LIMIT 50`,
          [userId],
        ),
      ),
    );
    return {
      investmentAccounts: accounts,
      categories: all
        .slice(0, PARSER_TOOL_MAX_CATEGORIES)
        .map(([id, name]) => ({ id, name })),
      totalCount: all.length,
      truncated: all.length > PARSER_TOOL_MAX_CATEGORIES,
      guide: EMAIL_RECEIPT_PARSER_LANGUAGE_GUIDE,
    };
  }

  /**
   * Every parser of the user's (at most `MAX_PARSERS_PER_USER`), newest change
   * first, as a summary. Reads only.
   */
  async listParsers(userId: string): Promise<ParserToolSummary[]> {
    const rows = await withScopedDb(this.dataSource, (m) =>
      m.getRepository(EmailReceiptParser).find({
        where: { userId },
        order: { updatedAt: "DESC", id: "DESC" },
        take: MAX_PARSERS_PER_USER,
      }),
    );
    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      fromDomains: row.fromDomains,
      subjectContains: row.subjectContains,
      status: row.status,
      source: row.source,
      revision: row.revision,
      definitionValid: validateReceiptParserDefinition(row.definition).ok,
      updatedAt: row.updatedAt.toISOString(),
    }));
  }

  /**
   * One parser of the user's, in any status, as a person's editor reads it: the
   * definition names categories by qualified name (`saveDraft` and
   * `testDefinition` resolve them back), so it can be edited and saved as a NEW
   * draft. Reads only. Not the user's, or absent: 404.
   */
  async getParser(userId: string, parserId: string): Promise<ParserToolDetail> {
    return withScopedDb(this.dataSource, async (m) => {
      // The MCP schema holds no uuid pattern (its byte budget); a malformed id
      // is an absent parser, not a database error.
      const row = isUUID(parserId)
        ? await m
            .getRepository(EmailReceiptParser)
            .findOne({ where: { id: parserId, userId } })
        : null;
      if (!row) {
        throw new NotFoundException(
          tr(
            "errors.emailReceipts.parserNotFound",
            `Receipt parser ${parserId} not found`,
            { id: parserId },
          ),
        );
      }
      const { reprocessableCount: _unused, ...view } = toParserView(
        row,
        await loadQualifiedCategoryNames(m, userId),
      );
      let payeeName: string | null = null;
      if (row.payeeId) {
        const payee = await m.getRepository(Payee).findOne({
          where: { id: row.payeeId, userId },
          select: { name: true },
        });
        payeeName = payee?.name ?? null;
      }
      return { ...view, payeeName };
    });
  }

  /**
   * The definition with the category NAMES it carries (`defaultCategory`, ...)
   * turned into the user's category ids, so an agent may write either. An
   * unknown or ambiguous name is a 400 naming it; nothing is written.
   */
  private resolveNames(userId: string, definition: unknown): Promise<unknown> {
    return withScopedDb(this.dataSource, (m) =>
      resolveParserCategoryNames(m, userId, definition),
    );
  }

  /**
   * Read 1 to 10 of the user's stored emails with a definition that is not saved.
   * An invalid definition is a RESULT (`valid: false` and every error with its
   * path), not an exception, so the agent can fix it and test again. Reads only:
   * nothing is written and no email changes. A category id the definition names
   * that is not the user's is listed in `unknownCategoryIds`, and an account id
   * that is not an open brokerage account of theirs in `unknownAccountIds`: the
   * draft would be refused on save.
   *
   * `componentDrafts` (a settlement under test only) are unsaved component
   * profiles: the dry run also reads the user's stored emails with them and joins
   * the settlement's parts to what they read (`links[].component.source`), without
   * writing anything. It is refused as a result (`valid: false`) on any other
   * role, and when its own definition or domains are invalid.
   */
  async testDefinition(
    userId: string,
    input: {
      definition: unknown;
      /** Emails to read; `samples` (which may also name the expected transaction) takes precedence. */
      receiptIds?: readonly string[];
      samples?: readonly ParserToolSample[];
      payeeName?: string;
      componentDrafts?: readonly ParserToolComponentDraft[];
    },
  ): Promise<ParserToolTestResult> {
    const samples: readonly ParserToolSample[] =
      input.samples ??
      (input.receiptIds ?? []).map((receiptId) => ({ receiptId }));
    if (samples.length < 1 || samples.length > PARSER_TOOL_MAX_RECEIPTS) {
      throw new ConflictException(
        tr(
          "errors.emailReceipts.parserToolReceiptCount",
          `Name 1 to ${PARSER_TOOL_MAX_RECEIPTS} emails to test the parser on.`,
          { max: PARSER_TOOL_MAX_RECEIPTS },
        ),
      );
    }
    const validation = validateReceiptParserDefinition(
      withVersion(await this.resolveNames(userId, input.definition)),
    );
    if (!validation.ok) {
      return {
        valid: false,
        errors: validation.errors,
        unknownCategoryIds: [],
        unknownAccountIds: [],
        emails: [],
        allComplete: false,
        allAgree: null,
      };
    }
    const definition: ReceiptParserDefinition = validation.definition;
    let componentDrafts: ComponentDraft[] | undefined;
    if (input.componentDrafts !== undefined) {
      const resolved: Array<{ definition: unknown; fromDomains: unknown }> = [];
      for (const draft of input.componentDrafts.slice(
        0,
        EMAIL_RECEIPT_PARSER_TOOL_MAX_DRAFTS + 1,
      )) {
        resolved.push({
          definition: withVersion(
            await this.resolveNames(userId, draft.definition),
          ),
          fromDomains: draft.fromDomains,
        });
      }
      const checked = checkComponentDrafts(definition, resolved);
      if (!checked.ok) {
        return {
          valid: false,
          errors: checked.errors,
          unknownCategoryIds: [],
          unknownAccountIds: [],
          emails: [],
          allComplete: false,
          allAgree: null,
        };
      }
      componentDrafts = checked.drafts;
    }
    const payee = input.payeeName
      ? await this.payees.resolveByName(userId, input.payeeName)
      : null;

    // One reader for every email of this call: each stored email is read once per
    // draft, and the call reads at most MAX_DRAFT_COMPONENT_READS emails in all.
    const draftReader = componentDrafts
      ? createDraftComponentReader(componentDrafts)
      : undefined;
    return withScopedDb(this.dataSource, async (m) => {
      const receipts = await m.getRepository(EmailReceipt).find({
        where: { userId, id: In(samples.map((sample) => sample.receiptId)) },
        select: {
          id: true,
          subject: true,
          bodyText: true,
          bodyHtml: true,
          receivedAt: true,
          originalSentAt: true,
        },
      });
      const byId = new Map(receipts.map((r) => [r.id, r]));
      const categoryNames = await loadQualifiedCategoryNames(m, userId);
      const expectedIds = samples.flatMap((sample) =>
        sample.transactionId ? [sample.transactionId] : [],
      );
      const transactions = await loadTransactionSummaries(
        m,
        userId,
        expectedIds,
      );
      const emails: ParserToolTestEmail[] = [];
      for (const sample of samples) {
        const receipt = byId.get(sample.receiptId);
        if (!receipt) throw receiptNotFound(sample.receiptId);
        const expectedTx = sample.transactionId
          ? transactions.get(sample.transactionId)
          : undefined;
        if (sample.transactionId && !expectedTx) {
          throw new NotFoundException(
            tr(
              "errors.emailReceipts.transactionNotFound",
              "That transaction was not found.",
            ),
          );
        }
        const run = await dryRunReceipt(
          m,
          userId,
          definition,
          receipt,
          payee,
          draftReader,
        );
        const { parsed, trace, outcome, match: matched, hit } = run;
        emails.push({
          receiptId: receipt.id,
          subject: receipt.subject,
          effectiveDate: run.effectiveDate.toISOString(),
          ...(run.trade
            ? {
                trade: {
                  parsed: toLlmTrade(run.trade.parsed),
                  trace: run.trade.trace,
                },
              }
            : {}),
          ...(run.component
            ? {
                linkKey: {
                  value: run.component.linkKey,
                  hit: trace.linkKey ?? null,
                },
                waitingSettlements: run.component.waitingSettlements
                  .slice(0, TRACE_MAX_ITEMS)
                  .map((settlement) => ({
                    receiptId: settlement.id,
                    subject: settlement.subject,
                    date: settlement.effectiveDate,
                  })),
              }
            : {}),
          ...(run.links
            ? {
                links: run.links.slice(0, TRACE_MAX_ITEMS).map((link) => ({
                  partIndex: link.partIndex,
                  link: link.link,
                  component: link.component
                    ? {
                        receiptId: link.component.id,
                        subject: link.component.subject,
                        effectiveDate: link.component.effectiveDate,
                        profileName: link.component.profileName,
                        source: link.component.source,
                      }
                    : null,
                  partAmount: units(link.partAmount) ?? 0,
                  componentNet: units(link.componentNet),
                  taken: units(link.taken),
                  outcome: link.outcome,
                  several: link.several,
                })),
              }
            : {}),
          parsed: toLlmParsed(parsed, categoryNames),
          outcome,
          trace: { ...trace, items: trace.items.slice(0, TRACE_MAX_ITEMS) },
          match: {
            outcome: run.component ? "component" : matched.kind,
            strategy: matched.kind === "unmatched" ? null : matched.strategy,
            transaction: hit
              ? {
                  id: hit.id,
                  date: hit.transactionDate,
                  amount: hit.amount,
                  payeeName: hit.payeeName,
                }
              : null,
            considered: matched.considered,
            attempts: matched.attempts.map((attempt) => ({
              strategy: attempt.strategy,
              count: attempt.count,
            })),
          },
          expected: expectedTx
            ? {
                transactionId: expectedTx.id,
                date: expectedTx.date,
                amount: expectedTx.amount,
                currencyCode: expectedTx.currencyCode,
                payeeName: expectedTx.payeeName,
              }
            : null,
          agreement: expectedTx
            ? compareWithExpected(
                parsed,
                run.purchaseDate,
                run.matchConfig,
                expectedTx,
              )
            : null,
        });
      }
      const unknownCategoryIds = [
        ...new Set([
          ...collectParserCategoryIds(definition),
          ...(componentDrafts ?? []).flatMap((draft) =>
            collectParserCategoryIds(draft.definition),
          ),
        ]),
      ].filter((id) => !categoryNames.has(id));
      const accountIds = collectParserAccountIds(definition);
      const usableAccounts = await usableTradeAccountIds(m, userId, accountIds);
      const unknownAccountIds = accountIds.filter(
        (id) => !usableAccounts.has(id),
      );
      return {
        valid: true,
        errors: [],
        unknownCategoryIds,
        unknownAccountIds,
        emails,
        ...(draftReader
          ? { componentDraftsExhausted: draftReader.exhausted }
          : {}),
        allComplete:
          unknownCategoryIds.length === 0 &&
          unknownAccountIds.length === 0 &&
          emails.every((email) =>
            email.trade ? email.trade.parsed.complete : email.parsed.complete,
          ),
        allAgree: emails.some((email) => email.agreement !== null)
          ? emails.every((email) => email.agreement?.agrees !== false)
          : null,
      };
    });
  }

  /**
   * Store a definition as a DRAFT parser and, when `requestId` names a
   * parser-draft request the caller has claimed, mark that request `proposed`
   * with `{ parserId }`. ONE transaction holds every check and every write, so a
   * refusal has written nothing: the request row is locked and checked first
   * (the user's, `email_parser_draft`, `claimed` by `caller`, not expired: else a
   * 409/404), then the parser cap, the payee and category ownership, the INSERT,
   * and the request's conditional UPDATE (`proposeParserDraft`).
   *
   * The definition goes through the one validator a person's parser passes. The
   * payee is looked up by name (`PayeesService.resolveByName`) and never created:
   * an unknown name leaves the parser without a payee, and the result says so.
   */
  async saveDraft(
    userId: string,
    caller: string,
    input: ParserToolSaveInput,
  ): Promise<ParserToolSaveResult> {
    const validation = validateReceiptParserDefinition(
      withVersion(await this.resolveNames(userId, input.definition)),
    );
    if (!validation.ok) throw invalidDefinitionError(validation.errors);
    const definition = validation.definition;
    const name = input.name.trim().slice(0, MAX_NAME_LENGTH);
    const fromDomains = [
      ...new Set(
        input.fromDomains
          .slice(0, EMAIL_RECEIPT_PARSER_MAX_FROM_DOMAINS)
          .map((domain) => normalizeReceiptDomain(domain) as string),
      ),
    ];
    if (
      name === "" ||
      fromDomains.length === 0 ||
      !fromDomains.every(isReceiptDomain)
    ) {
      throw new ConflictException(
        tr(
          "errors.emailReceipts.parserToolInvalidSender",
          "A draft needs a name and one to ten sender domains such as shop.example.com.",
        ),
      );
    }
    const subjectContains = [
      ...new Set(
        (input.subjectContains ?? [])
          .slice(0, EMAIL_RECEIPT_PARSER_MAX_SUBJECT_WORDS)
          .map((word) =>
            word.trim().toLowerCase().slice(0, MAX_SUBJECT_WORD_LENGTH),
          )
          .filter((word) => word !== ""),
      ),
    ];
    const payee = input.payeeName
      ? await this.payees.resolveByName(userId, input.payeeName)
      : null;

    return withScopedDb(this.dataSource, async (m) => {
      const request = input.requestId
        ? await this.lockClaimedRequest(m, userId, caller, input.requestId)
        : null;
      const repo = m.getRepository(EmailReceiptParser);
      let existing = input.parserId
        ? await this.lockDraft(
            m,
            userId,
            input.parserId,
            input.expectedRevision,
          )
        : null;
      // An answer to a request must not pile up drafts: when an unapproved draft
      // already covers the sender being answered, the newest one is updated (its
      // revision bumped) instead of a second one created.
      if (!existing && request) {
        const answered = request.domains.filter((domain) =>
          domainCoveredBy(domain, fromDomains),
        );
        // A request over several domains answers only the domains the draft
        // covers (a draft that covers none updates nothing); a one-domain
        // request answers the domain it is filed under, as it always did.
        const targets =
          request.domains.length > 1
            ? answered
            : request.parserDomain
              ? [request.parserDomain]
              : [];
        if (targets.length > 0) {
          // A draft the request already lists for one of these senders is the
          // one a new save updates; only then any other newest draft.
          if (request.status === "proposed" && request.parserIds.length > 0) {
            existing = await this.lockNewestDraftCovering(
              m,
              userId,
              targets,
              request.parserIds,
            );
          }
          existing ??= await this.lockNewestDraftCovering(m, userId, targets);
        }
      }
      // A request that already has a draft takes another one only for the other
      // sender of a multi-domain request (or an update of one it has).
      if (request?.status === "proposed") {
        await this.assertSecondDraftAccepted(
          m,
          userId,
          request,
          existing,
          fromDomains,
        );
      }
      if (
        !existing &&
        (await repo.count({ where: { userId } })) >= MAX_PARSERS_PER_USER
      ) {
        throw new ConflictException(
          tr(
            "errors.emailReceipts.tooManyParsers",
            `At most ${MAX_PARSERS_PER_USER} parsers can be saved. Delete one first.`,
            { max: MAX_PARSERS_PER_USER },
          ),
        );
      }
      await assertParserReferencesOwned(m, userId, {
        payeeId: payee?.id ?? null,
        categoryIds: collectParserCategoryIds(definition),
        accountIds: collectParserAccountIds(definition),
      });
      let saved: EmailReceiptParser;
      if (existing) {
        await repo.update(
          { id: existing.id, userId },
          {
            name,
            payeeId: payee?.id ?? null,
            fromDomains,
            subjectContains,
            definition:
              definition as unknown as QueryDeepPartialEntity<EmailReceiptParser>["definition"],
            revision: () => "revision + 1",
          },
        );
        saved = await repo.findOneByOrFail({ id: existing.id, userId });
      } else {
        saved = await repo.save(
          repo.create({
            userId,
            name,
            payeeId: payee?.id ?? null,
            fromDomains,
            subjectContains,
            definition: definition as unknown as Record<string, unknown>,
            status: "draft",
            source: "ai",
            approvedAt: null,
          }),
        );
      }
      let requestProposed = false;
      if (input.requestId) {
        requestProposed = await this.requests.proposeParserDraft(
          m,
          userId,
          input.requestId,
          caller,
          saved.id,
        );
        // The row was locked and checked above, so a miss here means the claim
        // moved in between: refuse, and the throw rolls the parser back.
        if (!requestProposed) throw requestNotClaimed();
      }
      return {
        parserId: saved.id,
        name: saved.name,
        status: "draft" as const,
        revision: saved.revision,
        fromDomains: saved.fromDomains,
        payee: payee ? { id: payee.id, name: payee.name } : null,
        match:
          definition.trade === undefined
            ? effectiveMatchDefinition(definition)
            : null,
        requestProposed,
      };
    });
  }

  /**
   * Lock the draft an update targets and refuse unless it is the user's, still a
   * draft (an approved parser reads mail and is only ever changed by a person)
   * and still at `expectedRevision`. Runs in the transaction of the write, under
   * the row lock, so a refusal has written nothing.
   */
  private async lockDraft(
    m: EntityManager,
    userId: string,
    parserId: string,
    expectedRevision: number | undefined,
  ): Promise<EmailReceiptParser> {
    const row = await m.getRepository(EmailReceiptParser).findOne({
      where: { id: parserId, userId },
      lock: { mode: "pessimistic_write" },
    });
    if (!row) {
      throw new NotFoundException(
        tr(
          "errors.emailReceipts.parserNotFound",
          `Receipt parser ${parserId} not found`,
          { id: parserId },
        ),
      );
    }
    if (row.status !== "draft") {
      throw new ConflictException(
        tr(
          "errors.emailReceipts.parserNotDraft",
          "Only a draft parser can be updated by the assistant. This one is approved.",
        ),
      );
    }
    if (expectedRevision === undefined || row.revision !== expectedRevision) {
      throw new ConflictException(
        tr(
          "errors.emailReceipts.parserRevisionConflict",
          "This parser was changed since you opened it. Reload it and try again.",
        ),
      );
    }
    return row;
  }

  /**
   * The newest DRAFT parser of the user's that covers any of `domains` (names one
   * or a parent of one, as the uncovered-domains list reads `from_domains`),
   * locked for the update, or null. No revision compare: the caller is an agent
   * answering a request, not a person who read a revision.
   */
  private async lockNewestDraftCovering(
    m: EntityManager,
    userId: string,
    domains: readonly string[],
    among: readonly string[] | null = null,
  ): Promise<EmailReceiptParser | null> {
    const rows = returnedRows<{ id: string }>(
      await m.query(
        `SELECT p.id
           FROM email_receipt_parsers p
          WHERE p.user_id = $1
            AND p.status = 'draft'
            AND ($3::uuid[] IS NULL OR p.id = ANY($3::uuid[]))
            AND EXISTS (
                  SELECT 1
                    FROM unnest(p.from_domains) AS pd(domain)
                    CROSS JOIN unnest($2::varchar[]) AS d(domain)
                   WHERE d.domain = pd.domain
                      OR right(d.domain, length(pd.domain) + 1)
                         = '.' || pd.domain)
          ORDER BY p.updated_at DESC, p.id DESC
          LIMIT 1`,
        [userId, [...domains], among ? [...among] : null],
      ),
    );
    if (rows.length === 0) return null;
    return m.getRepository(EmailReceiptParser).findOne({
      where: { id: rows[0].id, userId, status: "draft" },
      lock: { mode: "pessimistic_write" },
    });
  }

  /**
   * Lock the named request and refuse unless it is the user's parser-draft
   * request, claimed by `caller` and still alive. A request that spans several sender
   * domains is also accepted while `proposed` (a draft saved, other senders'
   * to come); `assertSecondDraftAccepted` then decides which drafts. The
   * check runs before the parser is written, in the same transaction, so a
   * refusal has written nothing. Returns the domain the request is filed under,
   * the distinct sender domains of its emails (read now, in this transaction),
   * its status and the parsers it already lists.
   */
  private async lockClaimedRequest(
    m: EntityManager,
    userId: string,
    caller: string,
    requestId: string,
  ): Promise<LockedDraftRequest> {
    const rows = returnedRows<{
      kind: string;
      status: string;
      claimed_by: string | null;
      parser_domain: string | null;
      proposal: { parserId?: unknown; parserIds?: unknown } | null;
      domains: string[];
      live: boolean;
    }>(
      await m.query(
        `SELECT kind, status, claimed_by, parser_domain, proposal,
                (expires_at > CURRENT_TIMESTAMP) AS live,
                ARRAY(SELECT DISTINCT r.from_domain
                        FROM email_receipts r
                       WHERE r.user_id = $2
                         AND r.id = ANY(email_receipt_ids)
                         AND r.from_domain <> ''
                       ORDER BY 1) AS domains
           FROM ai_review_requests
          WHERE id = $1
            AND user_id = $2
            FOR UPDATE`,
        [requestId, userId],
      ),
    );
    const row = rows[0];
    if (!row) {
      throw new NotFoundException(
        tr(
          "errors.aiReview.notFound",
          `AI review request with ID ${requestId} not found`,
          { id: requestId },
        ),
      );
    }
    const twoDomains = row.domains.length > 1;
    if (
      row.kind !== "email_parser_draft" ||
      !(
        row.status === "claimed" ||
        (row.status === "proposed" && twoDomains)
      ) ||
      row.claimed_by !== caller ||
      !row.live
    ) {
      throw requestNotClaimed();
    }
    const listed = Array.isArray(row.proposal?.parserIds)
      ? row.proposal.parserIds
      : [row.proposal?.parserId];
    return {
      parserDomain: row.parser_domain,
      domains: row.domains,
      status: row.status,
      parserIds: listed.filter((id): id is string => typeof id === "string"),
    };
  }

  /**
   * A `proposed` multi-domain request takes another save only for a domain of the
   * request that no listed draft covers (and while it lists fewer than
   * `MAX_PARSER_DRAFT_DOMAINS` drafts: the conditional UPDATE in
   * `proposeParserDraft` holds that, as the authority), or as an update of a
   * draft it lists. A draft that covers no domain of the request is refused
   * before anything is written.
   */
  private async assertSecondDraftAccepted(
    m: EntityManager,
    userId: string,
    request: LockedDraftRequest,
    existing: EmailReceiptParser | null,
    fromDomains: readonly string[],
  ): Promise<void> {
    if (existing && request.parserIds.includes(existing.id)) return;
    const listed =
      request.parserIds.length === 0
        ? []
        : await m.getRepository(EmailReceiptParser).find({
            where: { userId, id: In(request.parserIds) },
            select: { id: true, fromDomains: true },
          });
    const uncovered = request.domains.filter(
      (domain) =>
        domainCoveredBy(domain, fromDomains) &&
        !listed.some((parser) => domainCoveredBy(domain, parser.fromDomains)),
    );
    if (uncovered.length === 0) throw requestAlreadyAnswered();
  }
}

/** What `lockClaimedRequest` read about a parser-draft request. */
interface LockedDraftRequest {
  /** The domain the request is filed under (null for a request without one). */
  parserDomain: string | null;
  /** The distinct sender domains of its emails. */
  domains: string[];
  status: string;
  /** The parsers its proposal lists, in save order. */
  parserIds: string[];
}

/** `domain` is one of `covering` or a sub-domain of one (the module's own rule). */
function domainCoveredBy(domain: string, covering: readonly string[]): boolean {
  return covering.some(
    (parent) => domain === parent || domain.endsWith(`.${parent}`),
  );
}

function requestNotClaimed(): ConflictException {
  return new ConflictException(
    tr(
      "errors.emailReceipts.parserDraftRequestNotClaimed",
      "This parser draft request is not claimed by you. Claim it first with ai_review_requests, or save the draft without a requestId.",
    ),
  );
}

function requestAlreadyAnswered(): ConflictException {
  return new ConflictException(
    tr(
      "errors.emailReceipts.parserDraftRequestAnswered",
      "This request already has a draft for each of its senders. Update one of them with parserId, or save the draft without a requestId.",
    ),
  );
}

function receiptNotFound(id: string): NotFoundException {
  return new NotFoundException(
    tr("errors.emailReceipts.receiptNotFound", `Email ${id} not found`, { id }),
  );
}
