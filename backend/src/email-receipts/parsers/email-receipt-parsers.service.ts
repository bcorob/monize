import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { DataSource, EntityManager, In, QueryDeepPartialEntity } from "typeorm";
import {
  MAX_PARSER_DRAFT_DOMAINS,
  MAX_PARSER_DRAFT_EMAILS_PER_DOMAIN,
} from "../../ai-review/ai-review-request.entity";
import { AiReviewRequestsService } from "../../ai-review/ai-review-requests.service";
import { loadQualifiedCategoryNames } from "../../categories/category-name.util";
import { returnedRows } from "../../common/db/query-result";
import { withScopedDb } from "../../common/db/scoped-db";
import { tr } from "../../i18n/translate";
import { Payee } from "../../payees/entities/payee.entity";
import { EmailReceiptParser } from "../entities/email-receipt-parser.entity";
import { EmailReceipt } from "../entities/email-receipt.entity";
import type { ReceiptMatchResult } from "../matching/match-receipt";
import {
  buildMatchTrace,
  type ReceiptMatchTrace,
} from "../matching/match-trace";
import type { ReceiptOutcome } from "../parsing/parse-receipt";
import {
  appliedReviewClause,
  coveredByDomainSql,
} from "../linking/component-reread";
import { EMAIL_RECEIPT_PROCESSABLE_STATUSES } from "../receipts/dto/email-receipts.dto";
import { dryRunReceipt, type DryRunLink } from "./receipt-dry-run";
import {
  checkComponentDrafts,
  createDraftComponentReader,
  type ComponentDraft,
} from "./component-draft";
import type { WaitingSettlement } from "../linking/waiting-settlements";
import type {
  ParsedReceipt,
  ParsedTrade,
  ReceiptParserDefinition,
  ReceiptTrace,
  ReceiptTradeTrace,
} from "../parsing/receipt-parser.types";
import {
  collectParserAccountIds,
  collectParserCategoryIds,
  validateReceiptParserDefinition,
} from "../parsing/receipt-parser.validation";
import { isReceiptDomain } from "./dto/receipt-domain.validator";
import {
  RECEIPT_MULTI_DOMAIN_PARSER_DRAFT_INSTRUCTION,
  RECEIPT_PARSER_DRAFT_INSTRUCTION,
  RECEIPT_TRADE_PARSER_DRAFT_INSTRUCTION,
} from "./parser-draft-instruction";
import {
  ApproveEmailReceiptParserDto,
  CreateEmailReceiptParserDto,
  TestEmailReceiptParserDto,
  UpdateEmailReceiptParserDto,
} from "./dto/email-receipt-parser.dto";
import {
  toParserView,
  type EmailReceiptParserView,
} from "./email-receipt-parser.view";
import { resolveParserCategoryNames } from "./parser-category-names.util";
import {
  assertParserReferencesOwned,
  invalidDefinitionError,
} from "./parser-references.util";

/** A user holds at most this many parsers: the pipeline reads them all for each email. */
export const MAX_PARSERS_PER_USER = 200;

/** What "draft a parser with AI" answers: the request that now waits for an agent. */
export interface ParserDraftRequestResult {
  ok: true;
  requestId: string;
}

/**
 * The sender domain a parser draft is for: the most common non-empty domain of
 * the emails (the first one named wins a tie). Emails of different senders may be
 * selected together; the request is filed under the one most of them share.
 */
export function dominantSenderDomain(domains: readonly string[]): string {
  const counts = new Map<string, number>();
  for (const domain of domains) {
    if (domain !== "") counts.set(domain, (counts.get(domain) ?? 0) + 1);
  }
  let best = "";
  let bestCount = 0;
  for (const [domain, count] of counts) {
    if (count > bestCount) {
      best = domain;
      bestCount = count;
    }
  }
  return best;
}

/** What a parser test returns: the read, and what the matcher would do with it. */
export interface EmailReceiptParserTestResult {
  parsed: ParsedReceipt;
  /** Which entry and which line read each value (see `ReceiptTrace`). */
  trace: ReceiptTrace;
  /** `read`, or the guard (`requireLine`, `skipIfLine`, `waitIfLine`) that stops the pipeline reading it. */
  outcome: ReceiptOutcome;
  match: ReceiptMatchResult;
  /**
   * What the matcher looked at: the profile's window, strategies and tolerance,
   * and the transactions each strategy kept (design 5.5).
   */
  matchTrace: ReceiptMatchTrace;
  /** Candidate transactions the matcher was given (at most 200). */
  candidateCount: number;
  /** The matched transaction, when there is one. */
  transaction: {
    id: string;
    date: string;
    amount: number;
    payeeName: string | null;
  } | null;
  /**
   * For a profile with a `trade` section: what it read and which line read each
   * value. Such a profile is not matched to a bank transaction, so `parsed`,
   * `trace`, `match` and `transaction` are then empty. Absent for a receipt.
   */
  trade?: { parsed: ParsedTrade; trace: ReceiptTradeTrace };
  /**
   * For a `component` profile (linked receipts spec 10): the link value it read
   * (the trace's `linkKey` holds the line) and the settlements waiting for it,
   * newest first, at most 20. Such an email is not matched to a bank
   * transaction, so `match` is the empty "unmatched, considered 0" result.
   */
  component?: {
    linkKey: string | null;
    waitingSettlements: WaitingSettlement[];
  };
  /**
   * For a `settlement` profile: one entry per part, amounts in 1/10000 units.
   * `parsed` is then the JOINED reading, which `match` is computed from.
   */
  links?: DryRunLink[];
  /**
   * Present when the test carried `componentDrafts`: true when the read limit
   * (`MAX_DRAFT_COMPONENT_READS` stored emails) left emails the drafts cover
   * unread, so a part reported `not_found` may still have a component.
   */
  componentDraftsExhausted?: boolean;
}

/**
 * The parsers a user owns (design sections 5 and 8): create, edit under a
 * compare-and-swap revision, approve, delete, and test a draft definition
 * against a stored email without writing anything. A definition is validated by
 * the one validator the AI draft also passes; a payee or category the user does
 * not own is refused in the write's own transaction.
 *
 * It also queues "draft a parser with AI" requests (`requestAiDraft`, no
 * provider call: an assistant or an MCP agent answers them with the
 * `email_receipt_parsers` tool) and closes the loop on them: approving a draft
 * marks the request that proposed it `applied`, and deleting it dismisses that
 * request, each in the transaction of the change itself.
 */
@Injectable()
export class EmailReceiptParsersService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly requests: AiReviewRequestsService,
  ) {}

  async list(userId: string): Promise<EmailReceiptParserView[]> {
    return withScopedDb(this.dataSource, async (m) => {
      const rows = await m.getRepository(EmailReceiptParser).find({
        where: { userId },
        order: { name: "ASC", id: "ASC" },
        take: MAX_PARSERS_PER_USER * 5,
      });
      const names = await loadQualifiedCategoryNames(m, userId);
      const counts = await reprocessableCounts(m, userId);
      return rows.map((row) =>
        toParserView(row, names, counts.get(row.id) ?? 0),
      );
    });
  }

  async get(userId: string, id: string): Promise<EmailReceiptParserView> {
    return withScopedDb(this.dataSource, async (m) => {
      const row = await m
        .getRepository(EmailReceiptParser)
        .findOne({ where: { id, userId } });
      if (!row) throw parserNotFound(id);
      return this.view(m, userId, row);
    });
  }

  /** A manual parser is approved on creation: the person who wrote it is the approval. */
  async create(
    userId: string,
    dto: CreateEmailReceiptParserDto,
  ): Promise<EmailReceiptParserView> {
    return withScopedDb(this.dataSource, async (m) => {
      const repo = m.getRepository(EmailReceiptParser);
      // The cap is a bound on work per email, not a security limit: two
      // concurrent creates can overshoot it by one.
      if ((await repo.count({ where: { userId } })) >= MAX_PARSERS_PER_USER) {
        throw new ConflictException(
          tr(
            "errors.emailReceipts.tooManyParsers",
            `At most ${MAX_PARSERS_PER_USER} parsers can be saved. Delete one first.`,
            { max: MAX_PARSERS_PER_USER },
          ),
        );
      }
      const definition = validDefinition(
        await resolveParserCategoryNames(m, userId, dto.definition),
      );
      await assertParserReferencesOwned(m, userId, {
        payeeId: dto.payeeId ?? null,
        categoryIds: collectParserCategoryIds(definition),
        accountIds: collectParserAccountIds(definition),
      });
      const saved = await repo.save(
        repo.create({
          userId,
          name: dto.name,
          payeeId: dto.payeeId ?? null,
          fromDomains: unique(dto.fromDomains),
          subjectContains: unique(dto.subjectContains ?? []),
          definition: definition as unknown as Record<string, unknown>,
          status: "approved",
          source: "manual",
          approvedAt: new Date(),
        }),
      );
      return this.view(m, userId, saved);
    });
  }

  /**
   * Change a parser the caller has read at `expectedRevision`. The row is locked
   * first and the revision compared under the lock (404 for a missing row, 409
   * for one that has moved on), every reference is checked, and only then is
   * anything written. The status is unchanged: an approved parser stays
   * approved, because the person editing it is its author.
   */
  async update(
    userId: string,
    id: string,
    dto: UpdateEmailReceiptParserDto,
  ): Promise<EmailReceiptParserView> {
    return withScopedDb(this.dataSource, async (m) => {
      const repo = m.getRepository(EmailReceiptParser);
      const existing = await this.lockParser(m, userId, id);
      if (existing.revision !== dto.expectedRevision) {
        throw revisionConflict();
      }
      const definition =
        dto.definition === undefined
          ? undefined
          : validDefinition(
              await resolveParserCategoryNames(m, userId, dto.definition),
            );
      const payeeId =
        dto.payeeId === undefined ? existing.payeeId : (dto.payeeId ?? null);
      await assertParserReferencesOwned(m, userId, {
        payeeId: payeeId !== existing.payeeId ? payeeId : null,
        categoryIds: definition ? collectParserCategoryIds(definition) : [],
        accountIds: definition ? collectParserAccountIds(definition) : [],
      });
      await repo.update(
        { id, userId },
        {
          ...(dto.name === undefined ? {} : { name: dto.name }),
          payeeId,
          ...(dto.fromDomains === undefined
            ? {}
            : { fromDomains: unique(dto.fromDomains) }),
          ...(dto.subjectContains === undefined
            ? {}
            : { subjectContains: unique(dto.subjectContains) }),
          ...(definition === undefined
            ? {}
            : {
                definition:
                  definition as unknown as QueryDeepPartialEntity<EmailReceiptParser>["definition"],
              }),
          revision: () => "revision + 1",
        },
      );
      return this.view(m, userId, await repo.findOneByOrFail({ id, userId }));
    });
  }

  /**
   * Delete a parser. An open parser-draft request that proposed it is dismissed
   * in the same transaction, so the inbox never offers a draft that is gone; a
   * missing parser is a 404 that has written nothing (the throw rolls it back).
   */
  async remove(userId: string, id: string): Promise<void> {
    await withScopedDb(this.dataSource, async (m) => {
      const deleted = await m
        .getRepository(EmailReceiptParser)
        .delete({ id, userId });
      if (!deleted.affected) throw parserNotFound(id);
      await this.requests.dismissParserDraftsFor(m, userId, id);
    });
  }

  /**
   * Queue a request for an assistant (or an MCP agent) to write a parser from
   * 1 to 25 of the user's stored emails of one to five senders (at most 5 per
   * sender; a trade draft takes one sender). No provider is called here: the
   * request waits `pending` in the AI review inbox, and the receipts page opens
   * the chat with the emails attached, or says it waits for an agent. ONE
   * transaction holds every check and the write, so a refusal has written
   * nothing: every email must be the user's (an email that is not is a 404, never
   * read as absent) and must have been read (a `skipped` one has no text), every
   * sender domain must be a usable one, and the selection must keep to the limits
   * (400). The request is filed under the most common sender; several senders get the
   * multi-sender instruction (spec 10a). At most one request is open per (user,
   * domain): a new one replaces the open one (`enqueueParserDraft`).
   */
  async requestAiDraft(
    userId: string,
    receiptIds: readonly string[],
    kind: "receipt" | "trade" = "receipt",
  ): Promise<ParserDraftRequestResult> {
    return withScopedDb(this.dataSource, async (m) => {
      const rows = await m.getRepository(EmailReceipt).find({
        where: { userId, id: In([...receiptIds]) },
        select: { id: true, fromDomain: true, status: true },
      });
      const byId = new Map(rows.map((row) => [row.id, row]));
      for (const id of receiptIds) {
        if (!byId.has(id)) throw receiptNotFound(id);
      }
      if (rows.some((row) => row.status === "skipped")) {
        throw new ConflictException(
          tr(
            "errors.emailReceipts.receiptSkipped",
            "This email could not be read (it was too large or could not be decoded), so there is nothing to process.",
          ),
        );
      }
      const senderDomains = receiptIds.map(
        (id) => byId.get(id)?.fromDomain ?? "",
      );
      const domain = dominantSenderDomain(senderDomains);
      const distinctDomains = [
        ...new Set(senderDomains.filter((d) => d !== "")),
      ];
      if (!isReceiptDomain(domain) || !distinctDomains.every(isReceiptDomain)) {
        throw new BadRequestException(
          tr(
            "errors.emailReceipts.receiptNoSender",
            "This email has no usable sender domain, so a parser cannot be drafted for it.",
          ),
        );
      }
      assertDraftSelectionWithinLimits(senderDomains, distinctDomains, kind);
      const request = await this.requests.enqueueParserDraft(m, userId, {
        emailReceiptIds: receiptIds,
        parserDomain: domain,
        instruction:
          kind === "trade"
            ? RECEIPT_TRADE_PARSER_DRAFT_INSTRUCTION
            : distinctDomains.length > 1
              ? RECEIPT_MULTI_DOMAIN_PARSER_DRAFT_INSTRUCTION
              : RECEIPT_PARSER_DRAFT_INSTRUCTION,
      });
      return { ok: true as const, requestId: request.id };
    });
  }

  /**
   * Draft to approved. Under the row lock, the stored definition must pass the
   * validator now (a draft restored from a backup can be `{}`) and every
   * category it names must still be the user's. Approving an approved parser is
   * a no-op. With `expectedRevision` the approval is of the version the person
   * read, not of an edit that landed since.
   */
  async approve(
    userId: string,
    id: string,
    dto: ApproveEmailReceiptParserDto = {},
  ): Promise<EmailReceiptParserView> {
    return withScopedDb(this.dataSource, async (m) => {
      const repo = m.getRepository(EmailReceiptParser);
      const names = await loadQualifiedCategoryNames(m, userId);
      const existing = await this.lockParser(m, userId, id);
      if (
        dto.expectedRevision !== undefined &&
        existing.revision !== dto.expectedRevision
      ) {
        throw revisionConflict();
      }
      if (existing.status === "approved") {
        return this.view(m, userId, existing, names);
      }
      const definition = validDefinition(existing.definition);
      await assertParserReferencesOwned(m, userId, {
        payeeId: existing.payeeId,
        categoryIds: collectParserCategoryIds(definition),
        accountIds: collectParserAccountIds(definition),
      });
      await repo.update(
        { id, userId },
        {
          status: "approved",
          approvedAt: new Date(),
          revision: () => "revision + 1",
        },
      );
      // The request an agent answered with this draft is done with it: applied in
      // the same transaction as the approval, so the two commit or roll back
      // together. Nothing matching is fine (a draft written by hand).
      await this.requests.markParserDraftApplied(m, userId, id);
      return this.view(
        m,
        userId,
        await repo.findOneByOrFail({ id, userId }),
        names,
      );
    });
  }

  /**
   * Read a stored email with a definition that is not saved, and show what the
   * matcher would do with the result. Reads only: nothing is written.
   */
  async test(
    userId: string,
    dto: TestEmailReceiptParserDto,
  ): Promise<EmailReceiptParserTestResult> {
    const definition = validDefinition(dto.definition);
    return withScopedDb(this.dataSource, async (m) => {
      const receipt = await m.getRepository(EmailReceipt).findOne({
        where: { id: dto.receiptId, userId },
      });
      if (!receipt) {
        throw new NotFoundException(
          tr(
            "errors.emailReceipts.receiptNotFound",
            `Email ${dto.receiptId} not found`,
            { id: dto.receiptId },
          ),
        );
      }
      const payee = dto.payeeId
        ? await m.getRepository(Payee).findOne({
            where: { id: dto.payeeId, userId },
            select: { id: true, defaultCategoryId: true },
          })
        : null;
      if (dto.payeeId && !payee) {
        throw new NotFoundException(
          tr(
            "errors.emailReceipts.parserPayeeNotFound",
            "The payee of this parser was not found.",
          ),
        );
      }
      let componentDrafts: ComponentDraft[] | undefined;
      if (dto.componentDrafts !== undefined) {
        const checked = checkComponentDrafts(definition, dto.componentDrafts);
        if (!checked.ok) throw invalidDefinitionError(checked.errors);
        componentDrafts = checked.drafts;
      }
      const draftReader = componentDrafts
        ? createDraftComponentReader(componentDrafts)
        : undefined;
      const run = await dryRunReceipt(
        m,
        userId,
        definition,
        receipt,
        payee,
        draftReader,
      );
      const { parsed, trace, outcome, match, candidates, hit } = run;
      return {
        ...(draftReader
          ? { componentDraftsExhausted: draftReader.exhausted }
          : {}),
        ...(run.trade ? { trade: run.trade } : {}),
        ...(run.component ? { component: run.component } : {}),
        ...(run.links ? { links: run.links } : {}),
        parsed,
        trace,
        outcome,
        match,
        matchTrace: buildMatchTrace(
          run.purchaseDate,
          run.matchConfig,
          candidates,
          match,
        ),
        candidateCount: candidates.length,
        transaction: hit
          ? {
              id: hit.id,
              date: hit.transactionDate,
              amount: hit.amount,
              payeeName: hit.payeeName,
            }
          : null,
      };
    });
  }

  /** One parser as a client sees it, with the count of emails it could read again. */
  private async view(
    m: EntityManager,
    userId: string,
    row: EmailReceiptParser,
    names?: ReadonlyMap<string, string>,
  ): Promise<EmailReceiptParserView> {
    const counts = await reprocessableCounts(m, userId, [row.id]);
    return toParserView(
      row,
      names ?? (await loadQualifiedCategoryNames(m, userId)),
      counts.get(row.id) ?? 0,
    );
  }

  private async lockParser(
    m: EntityManager,
    userId: string,
    id: string,
  ): Promise<EmailReceiptParser> {
    const row = await m.getRepository(EmailReceiptParser).findOne({
      where: { id, userId },
      lock: { mode: "pessimistic_write" },
    });
    if (!row) throw parserNotFound(id);
    return row;
  }
}

/**
 * For the user's APPROVED parsers (or only `ids`), how many stored emails of
 * the parser's sender domains (a sub-domain matches, as in the pipeline) are in
 * a processable status and were last updated before the parser's last change:
 * the emails reading them again can change something. A `component` profile
 * also counts the applied `review` emails it covers (linked receipts spec 9). ONE statement however
 * many parsers; a parser with none is absent from the map. A draft reads no
 * mail, so it never counts.
 */
export async function reprocessableCounts(
  m: EntityManager,
  userId: string,
  ids: readonly string[] | null = null,
): Promise<Map<string, number>> {
  const rows = returnedRows<{ id: string; n: number | string }>(
    await m.query(
      `SELECT p.id, COUNT(r.id)::int AS n
         FROM email_receipt_parsers p
         JOIN email_receipts r
           ON r.user_id = p.user_id
          AND (r.status = ANY($2::varchar[])
               OR (p.definition->>'role' = 'component'
                   AND ${appliedReviewClause("r")}))
          AND r.updated_at < p.updated_at
          AND EXISTS (
                SELECT 1
                  FROM unnest(p.from_domains) AS pd(domain)
                 WHERE ${coveredByDomainSql("r", "pd.domain")})
        WHERE p.user_id = $1
          AND p.status = 'approved'
          AND ($3::uuid[] IS NULL OR p.id = ANY($3::uuid[]))
        GROUP BY p.id`,
      [userId, [...EMAIL_RECEIPT_PROCESSABLE_STATUSES], ids ? [...ids] : null],
    ),
  );
  return new Map(rows.map((row) => [row.id, Number(row.n)]));
}

/** The definition, or the 400 that lists every code the validator found. Never throws otherwise. */
function validDefinition(input: unknown): ReceiptParserDefinition {
  const validation = validateReceiptParserDefinition(input);
  if (!validation.ok) throw invalidDefinitionError(validation.errors);
  return validation.definition;
}

const unique = (values: readonly string[]): string[] => [...new Set(values)];

/**
 * The limits of a parser-draft selection (spec 10a), a 400 each, checked before
 * anything is written: at most `MAX_PARSER_DRAFT_DOMAINS` sender domains, at most
 * `MAX_PARSER_DRAFT_EMAILS_PER_DOMAIN` emails of one, and one domain for a trade
 * draft. `senders` is one domain per selected email ("" for none).
 */
function assertDraftSelectionWithinLimits(
  senders: readonly string[],
  distinctDomains: readonly string[],
  kind: "receipt" | "trade",
): void {
  if (distinctDomains.length > MAX_PARSER_DRAFT_DOMAINS) {
    throw new BadRequestException(
      tr(
        "errors.emailReceipts.draftTooManyDomains",
        `Select emails from at most ${MAX_PARSER_DRAFT_DOMAINS} senders.`,
        { max: MAX_PARSER_DRAFT_DOMAINS },
      ),
    );
  }
  if (kind === "trade" && distinctDomains.length > 1) {
    throw new BadRequestException(
      tr(
        "errors.emailReceipts.tradeDraftOneDomain",
        "A trade profile is drafted from one sender. Select trade emails from one sender only.",
      ),
    );
  }
  for (const domain of distinctDomains) {
    if (
      senders.filter((d) => d === domain).length >
      MAX_PARSER_DRAFT_EMAILS_PER_DOMAIN
    ) {
      throw new BadRequestException(
        tr(
          "errors.emailReceipts.draftTooManyPerDomain",
          `Select at most ${MAX_PARSER_DRAFT_EMAILS_PER_DOMAIN} emails from one sender.`,
          { max: MAX_PARSER_DRAFT_EMAILS_PER_DOMAIN },
        ),
      );
    }
  }
}

function receiptNotFound(id: string): NotFoundException {
  return new NotFoundException(
    tr("errors.emailReceipts.receiptNotFound", `Email ${id} not found`, { id }),
  );
}

function parserNotFound(id: string): NotFoundException {
  return new NotFoundException(
    tr(
      "errors.emailReceipts.parserNotFound",
      `Receipt parser ${id} not found`,
      { id },
    ),
  );
}

function revisionConflict(): ConflictException {
  return new ConflictException(
    tr(
      "errors.emailReceipts.parserRevisionConflict",
      "This parser was changed since you opened it. Reload it and try again.",
    ),
  );
}
