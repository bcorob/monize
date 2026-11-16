import { Global, Module } from "@nestjs/common";
import { TestingModule } from "@nestjs/testing";
import { DataSource } from "typeorm";

import { settlePendingHistoryWrites } from "@/action-history/action-history.service";
import { AiActionsService } from "@/ai/actions/ai-actions.service";
import {
  AI_DAILY_WRITE_LIMIT,
  AiWriteLimiter,
} from "@/ai/actions/ai-write-limiter";
import { AiModule } from "@/ai/ai.module";
import { AiService } from "@/ai/ai.service";
import { AiQueryService } from "@/ai/query/ai-query.service";
import { AiReviewModule } from "@/ai-review/ai-review.module";
import { AiReviewApprovalService } from "@/ai-review/ai-review-approval.service";
import { AiReviewRequestsService } from "@/ai-review/ai-review-requests.service";
import { AiReviewQueueModule } from "@/ai-review/ai-review-queue.module";
import { AiReviewWorkService } from "@/ai-review/ai-review-work.service";
import { EVENT_BUS } from "@/common/events/event-bus.interface";
import { MemoryEventBus } from "@/common/events/memory-event-bus";
import { JobClaimModule } from "@/common/jobs/job-claim.module";
import { withUserContext } from "@/common/db/with-context";
import { EncryptionService } from "@/common/encryption/encryption.service";
import { EmailReceiptCategoryAiService } from "@/email-receipts/ai/email-receipt-category-ai.service";
import { EmailReceiptsModule } from "@/email-receipts/email-receipts.module";
import { EmailReceiptPipelineService } from "@/email-receipts/pipeline/email-receipt-pipeline.service";
import {
  EmailReceiptParserGenerateService,
  type GenerateParserSavedResult,
} from "@/email-receipts/parsers/email-receipt-parser-generate.service";
import { EmailReceiptParserPreviewService } from "@/email-receipts/parsers/email-receipt-parser-preview.service";
import { EmailReceiptParserToolsService } from "@/email-receipts/parsers/email-receipt-parser-tools.service";
import { EmailReceiptParsersService } from "@/email-receipts/parsers/email-receipt-parsers.service";
import { EmailReceiptsService } from "@/email-receipts/receipts/email-receipts.service";
import {
  BadRequestException,
  ConflictException,
  NotFoundException,
  UnprocessableEntityException,
} from "@nestjs/common";
import { TransactionRulesModule } from "@/transaction-rules/transaction-rules.module";
import { TransactionsModule } from "@/transactions/transactions.module";
import { TransactionsService } from "@/transactions/transactions.service";

import {
  cleanTables,
  createEnforcedIntegrationModule,
  createTestUserDirect,
  EnforcedIntegrationHarness,
} from "../helpers/integration-setup";
import {
  createTestAccount,
  createTestCategory,
} from "../helpers/test-factories";

/** The in-process event bus a `single` deployment binds, without the app's module. */
@Global()
@Module({
  providers: [{ provide: EVENT_BUS, useClass: MemoryEventBus }, MemoryEventBus],
  exports: [EVENT_BUS],
})
class TestEventBusModule {}

/**
 * What a parser profile configures beyond reading the email, against a real
 * PostgreSQL enforcing RLS (email-receipts design 5.5, 5.6, 7.1, 8 and 9):
 * matching by the profile's own `match` section and `reference` field, the tag a
 * confirmed proposal adds, the AI's categories (and the queued request when it
 * cannot answer), "process in bulk" and the overview, the daily AI write limit and
 * the user's switch for profile proposals, and "approve selected" through the same
 * `confirm` a single approval uses.
 *
 * Synthetic data only: example.com addresses and invented names.
 */
describe("email receipts: what a profile configures (integration)", () => {
  jest.setTimeout(180000);

  let harness: EnforcedIntegrationHarness;
  let module: TestingModule;
  let db: DataSource;
  let receipts: EmailReceiptsService;
  let pipeline: EmailReceiptPipelineService;
  let parsers: EmailReceiptParsersService;
  let parserTools: EmailReceiptParserToolsService;
  let work: AiReviewWorkService;
  let approval: AiReviewApprovalService;
  let transactions: TransactionsService;
  let actions: AiActionsService;
  let limiter: AiWriteLimiter;
  let categoryAi: EmailReceiptCategoryAiService;
  let encryption: EncryptionService;
  let previews: EmailReceiptParserPreviewService;
  let generator: EmailReceiptParserGenerateService;
  let aiQuery: AiQueryService;
  let aiService: AiService;

  let aliceId: string;
  let bobId: string;
  let accountId: string;
  let booksId: string;
  let toysId: string;
  let shippingId: string;
  let mailboxId: string;

  const asAlice = <T>(fn: () => Promise<T>) => withUserContext(aliceId, fn);
  const asBob = <T>(fn: () => Promise<T>) => withUserContext(bobId, fn);

  const ORDER_BODY = [
    "Order number: ABCD1234",
    "Statement text: PAYU*998877",
    "Items",
    "Widget 8.00",
    "Gadget 4.00",
    "Subtotal 12.00",
    "Shipping: 3.00",
    "Order total: 15.00",
  ].join("\n");

  let uid = 0;
  const insertEmail = async (
    over: {
      body?: string;
      status?: string;
      domain?: string;
      receivedAt?: string;
      userId?: string;
      box?: string;
    } = {},
  ): Promise<string> => {
    uid += 1;
    const [row] = await db.query(
      `INSERT INTO email_receipts
         (user_id, mailbox_id, uid_validity, uid, from_address, from_domain,
          subject, received_at, body_text, status)
       VALUES ($1, $2, 1001, $3, $4, $5, 'Your order ABCD1234', $6, $7, $8)
       RETURNING id`,
      [
        over.userId ?? aliceId,
        over.box ?? mailboxId,
        uid,
        `orders@${over.domain ?? "shop.example.com"}`,
        over.domain ?? "shop.example.com",
        over.receivedAt ?? "2026-09-10T10:00:00Z",
        over.body ?? ORDER_BODY,
        over.status ?? "pending",
      ],
    );
    return row.id;
  };

  const createTx = async (
    over: {
      amount?: number;
      date?: string;
      description?: string;
      payeeName?: string;
    } = {},
  ) =>
    (
      await asAlice(() =>
        transactions.create(aliceId, {
          accountId,
          transactionDate: over.date ?? "2026-09-11",
          amount: over.amount ?? -15,
          currencyCode: "USD",
          description: over.description ?? "CARD PURCHASE",
          ...(over.payeeName ? { payeeName: over.payeeName } : {}),
        } as never),
      )
    ).id;

  const profile = (extra: Record<string, unknown> = {}) => ({
    version: 2,
    orderId: ["Order number: {orderid}"],
    reference: ["Statement text: {reference}"],
    total: ["Order total: {amount}"],
    shipping: ["Shipping: {amount}"],
    items: {
      startAfter: "Items",
      stopAt: "Subtotal",
      patterns: ["{name} {amount}"],
    },
    defaultCategoryId: booksId,
    shippingCategoryId: shippingId,
    ...extra,
  });

  const createParser = (definition: Record<string, unknown>) =>
    asAlice(() =>
      parsers.create(aliceId, {
        name: "Shop",
        fromDomains: ["shop.example.com"],
        definition,
      } as never),
    );

  const receiptRow = async (id: string) =>
    (await db.query(`SELECT * FROM email_receipts WHERE id = $1`, [id]))[0];
  const requestRows = () =>
    db.query(`SELECT * FROM ai_review_requests ORDER BY created_at`);
  const tagsOf = async (transactionId: string): Promise<string[]> =>
    (
      await db.query(
        `SELECT t.name FROM transaction_tags tt JOIN tags t ON t.id = tt.tag_id
          WHERE tt.transaction_id = $1 ORDER BY t.name`,
        [transactionId],
      )
    ).map((row: { name: string }) => row.name);

  const confirmCard = (card: {
    actionId: string;
    signature: string;
    descriptor: unknown;
  }) =>
    asAlice(() =>
      actions.confirm(aliceId, {
        actionId: card.actionId,
        signature: card.signature,
        descriptor: card.descriptor as Record<string, unknown>,
      }),
    );

  const fillDailyLimit = () =>
    asAlice(() =>
      limiter.record(aliceId, "update_transaction", AI_DAILY_WRITE_LIMIT),
    );

  beforeAll(async () => {
    process.env.JWT_SECRET ??= "integration-test-secret";
    process.env.ENCRYPTION_KEY ??= "x".repeat(40);
    harness = await createEnforcedIntegrationModule([
      JobClaimModule,
      TransactionsModule,
      TransactionRulesModule,
      AiReviewModule,
      AiReviewQueueModule,
      AiModule,
      EmailReceiptsModule,
      TestEventBusModule,
    ]);
    module = harness.module;
    db = harness.owner;
    receipts = module.get(EmailReceiptsService);
    pipeline = module.get(EmailReceiptPipelineService);
    parsers = module.get(EmailReceiptParsersService);
    parserTools = module.get(EmailReceiptParserToolsService);
    work = module.get(AiReviewWorkService);
    approval = module.get(AiReviewApprovalService);
    transactions = module.get(TransactionsService);
    actions = module.get(AiActionsService);
    limiter = module.get(AiWriteLimiter);
    categoryAi = module.get(EmailReceiptCategoryAiService);
    encryption = module.get(EncryptionService);
    previews = module.get(EmailReceiptParserPreviewService);
    generator = module.get(EmailReceiptParserGenerateService);
    aiQuery = module.get(AiQueryService);
    aiService = module.get(AiService);
  });

  afterAll(async () => {
    await settlePendingHistoryWrites();
    await harness.close();
  });

  beforeEach(async () => {
    jest.restoreAllMocks();
    await settlePendingHistoryWrites();
    await cleanTables(db, [
      "single_use_tokens",
      "auth_attempt_counters",
      "job_claims",
      "ai_review_requests",
      "email_receipts",
      "email_receipt_parsers",
      "email_receipt_mailboxes",
      "action_history",
      "transaction_tags",
      "transaction_splits",
      "transactions",
      "tags",
      "monthly_account_balances",
      "payees",
      "categories",
      "accounts",
      "users",
    ]);
    uid = 0;
    await db.query(
      `INSERT INTO currencies (code, name, symbol, decimal_places) VALUES ('USD', 'US Dollar', '$', 2) ON CONFLICT DO NOTHING`,
    );
    aliceId = (await createTestUserDirect(db, { firstName: "Alice" })).id;
    bobId = (await createTestUserDirect(db, { firstName: "Bob" })).id;
    accountId = (
      await createTestAccount(db, aliceId, {
        name: "Checking",
        currencyCode: "USD",
        openingBalance: 1000,
        currentBalance: 1000,
      })
    ).id;
    booksId = (await createTestCategory(db, aliceId, { name: "Books" })).id;
    toysId = (await createTestCategory(db, aliceId, { name: "Toys" })).id;
    shippingId = (await createTestCategory(db, aliceId, { name: "Shipping" }))
      .id;
    const [row] = await db.query(
      `INSERT INTO email_receipt_mailboxes
         (user_id, host, port, security, username, password_enc, enabled, ai_mode, auto_apply)
       VALUES ($1, '8.8.8.8', 993, 'tls', 'receipts@example.com', $2, true, 'off', false)
       RETURNING id`,
      [aliceId, encryption.encrypt("app-password-for-tests")],
    );
    mailboxId = row.id;
  });

  describe("matching by the profile (design 5.5)", () => {
    it("finds the transaction by the profile's reference in the fields it names, and stores the kind `reference`", async () => {
      await createParser(
        profile({
          match: { by: ["reference"], referenceIn: ["description"] },
        }),
      );
      await createTx({ amount: -99, description: "NOT IT" });
      const hit = await createTx({
        amount: -15,
        description: "CARD PAYU*998877 SHOP",
      });
      const id = await insertEmail();

      const result = await asAlice(() => pipeline.process(aliceId, id));

      expect(result).toMatchObject({
        status: "review",
        transactionId: hit,
        matchKind: "reference",
      });
      const row = await receiptRow(id);
      expect(row.match_kind).toBe("reference");
      expect(row.parsed).toMatchObject({ reference: "PAYU*998877" });
    });

    it("matches by an amount within the profile's tolerance and window, and stores `amount_date`", async () => {
      await createParser(
        profile({
          match: {
            by: ["amount_date"],
            amountTolerance: "0.50",
            daysBefore: 0,
            daysAfter: 40,
          },
        }),
      );
      // 30 days after the email, 15.40 for a 15.00 order: outside the default window and amount.
      const far = await createTx({ amount: -15.4, date: "2026-10-10" });
      const id = await insertEmail();

      const result = await asAlice(() => pipeline.process(aliceId, id));

      expect(result).toMatchObject({
        status: "review",
        transactionId: far,
        matchKind: "amount_date",
      });
      expect((await receiptRow(id)).match_kind).toBe("amount_date");
    });

    it("does not reach that transaction with the default window and an exact amount", async () => {
      await createParser(profile());
      await createTx({ amount: -15.4, date: "2026-10-10" });
      const id = await insertEmail();
      const result = await asAlice(() => pipeline.process(aliceId, id));
      expect(result.status).toBe("unmatched");
    });

    it("is ambiguous with exactly the candidates of the strategy that found several", async () => {
      await createParser(profile({ match: { by: ["amount_date"] } }));
      const a = await createTx({ amount: -15, description: "A" });
      const b = await createTx({ amount: -15, description: "B" });
      const id = await insertEmail();

      const result = await asAlice(() => pipeline.process(aliceId, id));

      expect(result.status).toBe("ambiguous");
      expect((await receiptRow(id)).candidate_transaction_ids.sort()).toEqual(
        [a, b].sort(),
      );
    });

    it("the REST test and the tool show the candidates considered and which strategy matched which transaction", async () => {
      const hit = await createTx({ description: "CARD PAYU*998877" });
      const id = await insertEmail();
      const definition = profile({
        match: { by: ["reference", "amount_date"] },
      });

      const rest = await asAlice(() =>
        parsers.test(aliceId, { definition, receiptId: id } as never),
      );
      expect(rest.match).toMatchObject({
        kind: "matched",
        transactionId: hit,
        matchKind: "reference",
        strategy: "reference",
      });
      expect(rest.matchTrace).toMatchObject({
        by: ["reference", "amount_date"],
        decidedBy: "reference",
        attempts: [
          { strategy: "reference", count: 1, transactions: [{ id: hit }] },
        ],
      });

      const tool = await asAlice(() =>
        parserTools.testDefinition(aliceId, {
          definition,
          receiptIds: [id],
        }),
      );
      expect(tool.emails[0].match).toMatchObject({
        outcome: "matched",
        strategy: "reference",
        transaction: { id: hit },
      });
      // Testing writes nothing: the receipt is as it was.
      expect((await receiptRow(id)).status).toBe("pending");
    });

    it("accepts the new match kinds in the table's CHECK as entities build it (reads of an old amount_only row too)", async () => {
      const id = await insertEmail();
      await db.query(
        `UPDATE email_receipts SET match_kind = 'amount_only' WHERE id = $1`,
        [id],
      );
      const [listed] = await asAlice(() => receipts.list(aliceId));
      expect(listed.matchKind).toBe("amount_only");
    });
  });

  describe("the profile's tag (design 5.5)", () => {
    it("is created and added at confirm, beside the tags the transaction already carries, in the write's own transaction", async () => {
      await createParser(profile({ tag: "Allegro" }));
      const tx = await createTx();
      // a tag the transaction already has stays
      const [{ id: existing }] = await db.query(
        `INSERT INTO tags (user_id, name) VALUES ($1, 'Household') RETURNING id`,
        [aliceId],
      );
      await db.query(
        `INSERT INTO transaction_tags (transaction_id, tag_id) VALUES ($1, $2)`,
        [tx, existing],
      );
      const id = await insertEmail();
      await asAlice(() => pipeline.process(aliceId, id));

      const [request] = await requestRows();
      expect(request.proposal.input.tagNames).toEqual(["Allegro"]);
      const card = request.proposal.action;
      // the card says the tag is new, and a proposal writes no tag
      expect(card.preview).toMatchObject({
        tagNames: ["Allegro"],
        newTagNames: ["Allegro"],
      });
      expect(await tagsOf(tx)).toEqual(["Household"]);
      expect(
        await db.query(`SELECT 1 FROM tags WHERE name = 'Allegro'`),
      ).toHaveLength(0);

      await confirmCard(card);

      expect(await tagsOf(tx)).toEqual(["Allegro", "Household"]);
      expect((await requestRows())[0].status).toBe("applied");
    });

    it("uses the user's own tag of that name (any case) instead of creating a second", async () => {
      await createParser(profile({ tag: "ALLEGRO" }));
      const tx = await createTx();
      await db.query(
        `INSERT INTO tags (user_id, name) VALUES ($1, 'allegro')`,
        [aliceId],
      );
      const id = await insertEmail();
      await asAlice(() => pipeline.process(aliceId, id));
      const [request] = await requestRows();
      // not new: the card shows the user's own spelling
      expect(request.proposal.action.preview).toMatchObject({
        tagNames: ["allegro"],
      });
      expect(request.proposal.action.preview.newTagNames).toBeUndefined();

      await confirmCard(request.proposal.action);

      expect(await tagsOf(tx)).toEqual(["allegro"]);
      expect(
        await db.query(`SELECT 1 FROM tags WHERE LOWER(name) = 'allegro'`),
      ).toHaveLength(1);
    });

    it("rolls the tag back with the edit when the request is no longer open: a refused confirm creates no tag", async () => {
      await createParser(profile({ tag: "Allegro" }));
      await createTx();
      const id = await insertEmail();
      await asAlice(() => pipeline.process(aliceId, id));
      const [request] = await requestRows();
      await db.query(`UPDATE ai_review_requests SET status = 'rejected'`);

      await expect(confirmCard(request.proposal.action)).rejects.toMatchObject({
        status: 409,
      });

      expect(await db.query(`SELECT 1 FROM tags`)).toHaveLength(0);
    });

    it("another user's tag of that name is not touched: tags are per user", async () => {
      await createParser(profile({ tag: "Allegro" }));
      await db.query(
        `INSERT INTO tags (user_id, name) VALUES ($1, 'Allegro')`,
        [bobId],
      );
      const tx = await createTx();
      const id = await insertEmail();
      await asAlice(() => pipeline.process(aliceId, id));
      const [request] = await requestRows();
      expect(request.proposal.action.preview.newTagNames).toEqual(["Allegro"]);
      await confirmCard(request.proposal.action);
      expect(await tagsOf(tx)).toEqual(["Allegro"]);
      expect(
        await db.query(`SELECT 1 FROM tags WHERE name = 'Allegro'`),
      ).toHaveLength(2);
    });
  });

  describe("the AI's categories for the items no rule matched (design 5.6)", () => {
    const bare = () =>
      profile({ defaultCategoryId: undefined, aiCategories: true });
    const setMode = (mode: string) =>
      db.query(`UPDATE email_receipt_mailboxes SET ai_mode = $1`, [mode]);

    it("asks the AI once, fills the items, marks them ai and proposes the split; the card marks the AI's categories", async () => {
      await createParser(bare());
      await setMode("on_demand");
      const tx = await createTx();
      const id = await insertEmail();
      jest.spyOn(categoryAi, "canAnswerNow").mockResolvedValue(true);
      const ask = jest.spyOn(categoryAi, "categorize").mockImplementation(
        async () =>
          new Map([
            [0, toysId],
            [1, booksId],
          ]),
      );

      const result = await asAlice(() => pipeline.process(aliceId, id));

      expect(ask).toHaveBeenCalledTimes(1);
      expect(ask.mock.calls[0][1].map((i) => i.name)).toEqual([
        "Widget",
        "Gadget",
      ]);
      expect(result).toMatchObject({ status: "review", transactionId: tx });
      const row = await receiptRow(id);
      expect(
        row.parsed.items.map(
          (i: { categorySource?: string }) => i.categorySource,
        ),
      ).toEqual(["ai", "ai"]);
      expect(row.parsed.complete).toBe(true);
      const [request] = await requestRows();
      expect(request).toMatchObject({
        status: "proposed",
        claimed_by: "email-receipts",
      });
      expect(request.proposal.action.preview.splits).toEqual([
        {
          categoryName: "Toys",
          amount: -8,
          memo: "Widget",
          categorySource: "ai",
        },
        {
          categoryName: "Books",
          amount: -4,
          memo: "Gadget",
          categorySource: "ai",
        },
        { categoryName: "Shipping", amount: -3, memo: null },
      ]);
      // the AI's mark is display only: nothing signed carries it
      expect(JSON.stringify(request.proposal.action.descriptor)).not.toContain(
        "categorySource",
      );
    });

    it("never calls the AI when the profile does not turn it on", async () => {
      await createParser(profile({ defaultCategoryId: undefined }));
      await setMode("on_demand");
      await createTx();
      const id = await insertEmail();
      const ask = jest.spyOn(categoryAi, "categorize");
      const can = jest.spyOn(categoryAi, "canAnswerNow");

      await asAlice(() => pipeline.process(aliceId, id));

      expect(can).not.toHaveBeenCalled();
      expect(ask).not.toHaveBeenCalled();
      expect((await requestRows())[0].instruction).toMatch(
        /^An order email read by a saved parser/,
      );
    });

    it("with the mailbox's AI mode off: items stay uncategorized and a pending request waits for an agent", async () => {
      await createParser(bare());
      const tx = await createTx();
      const id = await insertEmail();
      const ask = jest.spyOn(categoryAi, "categorize");

      const result = await asAlice(() => pipeline.process(aliceId, id));

      expect(ask).not.toHaveBeenCalled();
      expect(result).toMatchObject({ status: "review", transactionId: tx });
      const [request] = await requestRows();
      expect(request).toMatchObject({
        kind: "email_receipt",
        status: "pending",
        claimed_by: null,
        transaction_id: tx,
        email_receipt_id: id,
      });
      expect(request.instruction).toMatch(
        /^Assign a category to each uncategorized item/,
      );
      const row = await receiptRow(id);
      expect(row.ai_review_request_id).toBe(request.id);
      expect(
        row.parsed.items.every(
          (i: { categoryId: unknown }) => i.categoryId === null,
        ),
      ).toBe(true);
      expect(row.status_reason).toBe("items_uncategorized");
      // one open request per transaction: no profile proposal beside it
      expect(await requestRows()).toHaveLength(1);
    });

    it("an agent claims that request by id, and the poll's automatic step never takes it", async () => {
      await createParser(bare());
      await setMode("automatic");
      await createTx();
      const id = await insertEmail();
      jest.spyOn(categoryAi, "canAnswerNow").mockResolvedValue(false);

      await asAlice(() => pipeline.process(aliceId, id));
      const [request] = await requestRows();
      expect(request.status).toBe("pending");

      const claim = await asAlice(() =>
        work.claim(aliceId, "agent-1", request.id),
      );
      expect(claim.request).toMatchObject({
        id: request.id,
        claimedByYou: true,
      });
      expect(claim.emailReceipt?.text).toContain("Widget 8.00");
    });

    it("no provider answering now is the same: the question is not asked", async () => {
      await createParser(bare());
      await setMode("on_demand");
      await createTx();
      const id = await insertEmail();
      jest.spyOn(categoryAi, "canAnswerNow").mockResolvedValue(false);
      const ask = jest.spyOn(categoryAi, "categorize");

      await asAlice(() => pipeline.process(aliceId, id));

      expect(ask).not.toHaveBeenCalled();
      expect((await requestRows())[0].status).toBe("pending");
    });
  });

  describe("process in bulk and the overview (design 8 and 9)", () => {
    it("runs the pipeline over the emails oldest first and ends: an email that stays unmatched is not taken again by the same run", async () => {
      await createParser(profile());
      const t1 = await createTx({ amount: -15, description: "ORDER ABCD1234" });
      const e1 = await insertEmail({ receivedAt: "2026-09-10T10:00:00Z" });
      const e2 = await insertEmail({
        receivedAt: "2026-09-09T10:00:00Z",
        body: ORDER_BODY.replace("ABCD1234", "ZZZZ9999").replace(
          "15.00",
          "77.00",
        ),
      });
      const e3 = await insertEmail({
        receivedAt: "2026-09-08T10:00:00Z",
        domain: "other.example.org",
      });

      const first = await asAlice(() =>
        receipts.processBatch(aliceId, { limit: 2 }),
      );
      // oldest first: e3 then e2 (the limit is 2)
      expect(first.processed).toBe(2);
      expect(first.byOutcome).toMatchObject({ no_parser: 1, unmatched: 1 });
      expect(first.remaining).toBe(1);

      const second = await asAlice(() =>
        receipts.processBatch(aliceId, { limit: 2, since: first.since }),
      );
      expect(second).toMatchObject({ processed: 1, remaining: 0, failed: 0 });
      expect(second.byOutcome).toEqual({ review: 1 });
      expect((await receiptRow(e1)).transaction_id).toBe(t1);
      // e2 stayed unmatched and a third call of the run has nothing left to take
      const third = await asAlice(() =>
        receipts.processBatch(aliceId, { limit: 2, since: first.since }),
      );
      expect(third).toMatchObject({ processed: 0, remaining: 0 });
      expect((await receiptRow(e2)).status).toBe("unmatched");
      expect((await receiptRow(e3)).status).toBe("no_parser");
    });

    it("filters by sender domain and status, and leaves `review` emails and another user's alone", async () => {
      await createParser(profile());
      await createTx();
      const mine = await insertEmail();
      const other = await insertEmail({ domain: "other.example.org" });
      const reviewed = await insertEmail({ status: "review" });
      const [bobBox] = await db.query(
        `INSERT INTO email_receipt_mailboxes (user_id, host, username, password_enc)
         VALUES ($1, 'h', 'u', 'p') RETURNING id`,
        [bobId],
      );
      const bobs = await insertEmail({ userId: bobId, box: bobBox.id });

      const result = await asAlice(() =>
        receipts.processBatch(aliceId, { domain: "shop.example.com" }),
      );

      expect(result.processed).toBe(1);
      expect((await receiptRow(mine)).status).toBe("review");
      expect((await receiptRow(other)).status).toBe("pending");
      expect((await receiptRow(reviewed)).status).toBe("review");
      expect((await receiptRow(bobs)).status).toBe("pending");
      await expect(
        asBob(() => receipts.processBatch(bobId, { statuses: ["pending"] })),
      ).resolves.toMatchObject({ processed: 1 });
    });

    it("reports the overview from one statement: mailbox, emails by status, profiles, proposals to approve and the uncovered domains", async () => {
      await createParser(profile());
      await createTx();
      await insertEmail();
      await insertEmail({ domain: "pay.example.org", status: "no_parser" });
      await insertEmail({ domain: "pay.example.org", status: "no_parser" });
      await insertEmail({ domain: "shop.example.com", status: "no_parser" });
      await asAlice(() =>
        receipts.processBatch(aliceId, { statuses: ["pending"] }),
      );

      const overview = await asAlice(() => receipts.overview(aliceId));

      expect(overview.mailbox).toMatchObject({
        enabled: true,
        authMethod: "password",
        connected: true,
        aiMode: "off",
      });
      expect(overview.emailsByStatus).toMatchObject({
        review: 1,
        no_parser: 3,
      });
      expect(overview.parsers).toEqual({ approved: 1, draft: 0 });
      expect(overview.proposalsToApprove).toBe(1);
      // shop.example.com has a parser; pay.example.org has none
      expect(overview.domainsWithoutProfile).toEqual([
        { domain: "pay.example.org", count: 2 },
      ]);
      expect(overview.processable).toBe(3);

      const bobs = await asBob(() => receipts.overview(bobId));
      expect(bobs).toMatchObject({
        mailbox: null,
        emailsByStatus: {},
        proposalsToApprove: 0,
        domainsWithoutProfile: [],
      });
    });
  });

  describe("the profile wizard", () => {
    const draftFor = (domain: string) =>
      asAlice(() =>
        parserTools.saveDraft(aliceId, "assistant", {
          name: "Draft",
          fromDomains: [domain],
          definition: profile(),
        }),
      );

    it("lists the domains no approved profile covers, with the draft naming each; sub-domains of a covered domain are covered", async () => {
      await createParser(profile());
      const draft = await draftFor("pay.example.org");
      await insertEmail({ domain: "shop.example.com" });
      await insertEmail({ domain: "mail.shop.example.com" });
      await insertEmail({ domain: "notshop.example.com" });
      await insertEmail({ domain: "pay.example.org" });
      await insertEmail({ domain: "pay.example.org", status: "review" });
      const [bobBox] = await db.query(
        `INSERT INTO email_receipt_mailboxes (user_id, host, username, password_enc)
         VALUES ($1, 'h', 'u', 'p') RETURNING id`,
        [bobId],
      );
      await insertEmail({
        userId: bobId,
        box: bobBox.id,
        domain: "bob.example.org",
      });

      const mine = await asAlice(() => receipts.listUncoveredDomains(aliceId));

      expect(mine).toEqual([
        {
          domain: "pay.example.org",
          count: 2,
          draftParserId: draft.parserId,
          pendingRequestId: null,
          pendingRequestStatus: null,
        },
        {
          domain: "notshop.example.com",
          count: 1,
          draftParserId: null,
          pendingRequestId: null,
          pendingRequestStatus: null,
        },
      ]);
      await expect(
        asBob(() => receipts.listUncoveredDomains(bobId)),
      ).resolves.toEqual([
        {
          domain: "bob.example.org",
          count: 1,
          draftParserId: null,
          pendingRequestId: null,
          pendingRequestStatus: null,
        },
      ]);
    });

    it("counts the emails a parser could read again: processable, of its domains, last processed before its last change; drafts and other users' emails never", async () => {
      const reprocessable = await insertEmail({ status: "no_parser" });
      await insertEmail({ status: "review" });
      await insertEmail({
        domain: "mail.shop.example.com",
        status: "parse_failed",
      });
      await insertEmail({ domain: "other.example.org", status: "no_parser" });
      const [bobBox] = await db.query(
        `INSERT INTO email_receipt_mailboxes (user_id, host, username, password_enc)
         VALUES ($1, 'h', 'u', 'p') RETURNING id`,
        [bobId],
      );
      await insertEmail({ userId: bobId, box: bobBox.id, status: "no_parser" });
      const draft = await draftFor("shop.example.com");
      const approved = await createParser(profile());

      const list = await asAlice(() => parsers.list(aliceId));

      expect(
        list.find((p) => p.id === draft.parserId)?.reprocessableCount,
      ).toBe(0);
      expect(list.find((p) => p.id === approved.id)?.reprocessableCount).toBe(
        2,
      );
      expect(
        (await asAlice(() => parsers.get(aliceId, approved.id)))
          .reprocessableCount,
      ).toBe(2);

      // processing the emails moves their updated_at past the parser's: nothing left to read again
      await asAlice(() =>
        receipts.processBatch(aliceId, { domain: "shop.example.com" }),
      );
      expect(
        (await asAlice(() => parsers.get(aliceId, approved.id)))
          .reprocessableCount,
      ).toBe(0);
      expect((await receiptRow(reprocessable)).updated_at).toBeDefined();

      // a change to the parser makes the emails stale again
      await asAlice(() =>
        parsers.update(aliceId, approved.id, {
          expectedRevision: approved.revision,
          name: "Shop renamed",
        } as never),
      );
      expect(
        (await asAlice(() => parsers.get(aliceId, approved.id)))
          .reprocessableCount,
      ).toBeGreaterThan(0);
    });

    it("previews a draft over the domain's emails, agrees with the expected transaction, and writes nothing", async () => {
      const txId = await createTx();
      const sample = await insertEmail({ status: "no_parser" });
      const other = await insertEmail({
        status: "no_parser",
        body: "nothing to read here",
      });
      const draft = await draftFor("shop.example.com");
      const before = {
        emails: await db.query(
          `SELECT id, status, updated_at FROM email_receipts ORDER BY id`,
        ),
        requests: (await requestRows()).length,
        parsers: await db.query(
          `SELECT id, revision, updated_at FROM email_receipt_parsers ORDER BY id`,
        ),
      };

      const result = await asAlice(() =>
        previews.preview(aliceId, draft.parserId, {
          selectedReceiptIds: [sample],
          expected: [{ receiptId: sample, transactionId: txId }],
        }),
      );

      expect(result.selected).toHaveLength(1);
      expect(result.selected[0]).toMatchObject({
        receiptId: sample,
        outcome: "matched",
        agrees: true,
        match: { transactionId: txId },
        expected: { transactionId: txId },
        parsed: { total: 15, date: "2026-09-10" },
      });
      expect(result.others.map((o) => [o.receiptId, o.outcome])).toEqual([
        [other, "parse_failed"],
      ]);
      expect(result.othersTotal).toBe(1);
      expect(
        await db.query(
          `SELECT id, status, updated_at FROM email_receipts ORDER BY id`,
        ),
      ).toEqual(before.emails);
      expect((await requestRows()).length).toBe(before.requests);
      expect(
        await db.query(
          `SELECT id, revision, updated_at FROM email_receipt_parsers ORDER BY id`,
        ),
      ).toEqual(before.parsers);
    });

    it("another user's parser, email and transaction read as not found", async () => {
      const txId = await createTx();
      const sample = await insertEmail({ status: "no_parser" });
      const draft = await draftFor("shop.example.com");
      await expect(
        asBob(() =>
          previews.preview(bobId, draft.parserId, { selectedReceiptIds: [] }),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
      await expect(
        asAlice(() =>
          previews.preview(aliceId, draft.parserId, {
            selectedReceiptIds: [sample],
            expected: [
              {
                receiptId: sample,
                transactionId: "00000000-0000-4000-8000-000000000000",
              },
            ],
          }),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(txId).toBeDefined();
    });

    /** The user has a direct tool-capable provider (the synchronous path). */
    const directProvider = () =>
      jest
        .spyOn(aiService, "resolveToolUseProvider")
        .mockResolvedValue({ provider: {}, config: {} } as never);

    it("generate-with-ai queues a request for a user whose AI is their own agent, replaces it while unclaimed, refuses once claimed, and the agent's answers update one draft", async () => {
      const txId = await createTx();
      const sample = await insertEmail({ status: "no_parser" });
      const body = {
        domain: "shop.example.com",
        samples: [{ receiptId: sample, transactionId: txId }],
      };
      const run = jest.spyOn(aiQuery, "executeQuery");
      jest
        .spyOn(aiService, "resolveToolUseProvider")
        .mockRejectedValue(new BadRequestException("no provider"));
      jest
        .spyOn(aiService, "getStatus")
        .mockResolvedValue({ relayActive: true } as never);

      const first = await asAlice(() =>
        generator.generate(aliceId, body as never),
      );
      expect(first).toMatchObject({ status: "queued" });
      const second = await asAlice(() =>
        generator.generate(aliceId, {
          ...body,
          feedback: "again",
        } as never),
      );
      // replaced in place: the same request, still the only open one
      expect(second).toEqual(first);
      const open = await db.query(
        `SELECT id, status, parser_domain, email_receipt_ids
           FROM ai_review_requests WHERE kind = 'email_parser_draft'`,
      );
      expect(open).toEqual([
        {
          id: (first as { requestId: string }).requestId,
          status: "pending",
          parser_domain: "shop.example.com",
          email_receipt_ids: [sample],
        },
      ]);
      expect(run).not.toHaveBeenCalled();

      // the wizard waits on it
      const waiting = await asAlice(() =>
        receipts.listUncoveredDomains(aliceId),
      );
      expect(waiting).toEqual([
        {
          domain: "shop.example.com",
          count: 1,
          draftParserId: null,
          pendingRequestId: (first as { requestId: string }).requestId,
          pendingRequestStatus: "pending",
        },
      ]);

      // an agent that has claimed it is not talked over
      await db.query(
        `UPDATE ai_review_requests
            SET status = 'claimed', claimed_by = 'agent', claimed_at = now()`,
      );
      await expect(
        asAlice(() => generator.generate(aliceId, body as never)),
      ).rejects.toBeInstanceOf(ConflictException);

      // the agent answers; a second request answered later updates the same draft
      const answer = (requestId: string) =>
        asAlice(() =>
          parserTools.saveDraft(aliceId, "agent", {
            requestId,
            name: "Shop",
            fromDomains: ["shop.example.com"],
            definition: profile(),
          }),
        );
      const saved = await answer((first as { requestId: string }).requestId);
      expect(saved).toMatchObject({ revision: 1, requestProposed: true });
      const third = (await asAlice(() =>
        generator.generate(aliceId, body as never),
      )) as { requestId: string };
      await db.query(
        `UPDATE ai_review_requests
            SET status = 'claimed', claimed_by = 'agent', claimed_at = now()
          WHERE id = $1`,
        [third.requestId],
      );
      const again = await answer(third.requestId);
      expect(again).toMatchObject({ parserId: saved.parserId, revision: 2 });
      expect(
        await db.query(`SELECT revision FROM email_receipt_parsers`),
      ).toEqual([{ revision: 2 }]);
    });

    it("generate-with-ai refuses another user's data before the provider is called", async () => {
      const txId = await createTx();
      const sample = await insertEmail({ status: "no_parser" });
      const run = jest.spyOn(aiQuery, "executeQuery");
      directProvider();
      await expect(
        asBob(() =>
          generator.generate(bobId, {
            domain: "shop.example.com",
            samples: [{ receiptId: sample, transactionId: txId }],
          } as never),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(run).not.toHaveBeenCalled();
    });

    it("generate-with-ai returns the draft the run saved, updates it in place on a revision, and is a 422 when none was saved", async () => {
      const txId = await createTx();
      const sample = await insertEmail({ status: "no_parser" });
      const body = {
        domain: "shop.example.com",
        samples: [{ receiptId: sample, transactionId: txId }],
      };
      directProvider();
      const run = jest
        .spyOn(aiQuery, "executeQuery")
        .mockImplementationOnce(async () => {
          await asAlice(() =>
            parserTools.saveDraft(aliceId, "assistant", {
              name: "Shop",
              fromDomains: ["shop.example.com"],
              definition: profile(),
            }),
          );
          return { answer: "Saved." } as never;
        });

      const created = (await asAlice(() =>
        generator.generate(aliceId, body as never),
      )) as GenerateParserSavedResult;
      expect(created).toMatchObject({
        status: "saved",
        revision: 1,
        answer: "Saved.",
      });
      expect(
        await db.query(`SELECT status, source FROM email_receipt_parsers`),
      ).toEqual([{ status: "draft", source: "ai" }]);

      // a revision: the same draft is updated, never a second one
      run.mockImplementationOnce(async () => {
        await asAlice(() =>
          parserTools.saveDraft(aliceId, "assistant", {
            parserId: created.parserId,
            expectedRevision: created.revision,
            name: "Shop v2",
            fromDomains: ["shop.example.com"],
            definition: profile(),
          }),
        );
        return { answer: "Updated." } as never;
      });
      const revised = await asAlice(() =>
        generator.generate(aliceId, {
          ...body,
          parserId: created.parserId,
          feedback: "more",
        } as never),
      );
      expect(revised).toMatchObject({
        parserId: created.parserId,
        revision: 2,
      });
      expect(
        await db.query(`SELECT name, revision FROM email_receipt_parsers`),
      ).toEqual([{ name: "Shop v2", revision: 2 }]);

      // a stale revision is refused by the compare-and-swap, writing nothing
      await expect(
        asAlice(() =>
          parserTools.saveDraft(aliceId, "assistant", {
            parserId: created.parserId,
            expectedRevision: 1,
            name: "Stale",
            fromDomains: ["shop.example.com"],
            definition: profile(),
          }),
        ),
      ).rejects.toThrow();
      expect(
        (await db.query(`SELECT name FROM email_receipt_parsers`))[0].name,
      ).toBe("Shop v2");

      run.mockResolvedValueOnce({ answer: "I could not." } as never);
      await expect(
        asAlice(() =>
          generator.generate(aliceId, {
            ...body,
            parserId: created.parserId,
          } as never),
        ),
      ).rejects.toBeInstanceOf(UnprocessableEntityException);
    });
  });

  describe("the daily AI write limit and a profile's proposals (design 7.1)", () => {
    const profileProposal = async () => {
      await createParser(profile());
      const tx = await createTx();
      const id = await insertEmail();
      await asAlice(() => pipeline.process(aliceId, id));
      const [request] = await requestRows();
      return { tx, request };
    };
    const setSwitch = (counts: boolean) =>
      db.query(
        `UPDATE email_receipt_mailboxes SET profile_proposals_count_toward_ai_limit = $1`,
        [counts],
      );
    const counted = async () =>
      (await asAlice(() => limiter.checkLimit(aliceId))).currentCount;

    it("with the switch on (the default) a profile proposal counts, and is refused at the limit", async () => {
      const { request } = await profileProposal();
      await fillDailyLimit();

      await expect(confirmCard(request.proposal.action)).rejects.toMatchObject({
        status: 400,
      });
      expect((await requestRows())[0].status).toBe("proposed");
    });

    it("with the switch on, the confirm is recorded", async () => {
      const { request } = await profileProposal();
      await confirmCard(request.proposal.action);
      expect(await counted()).toBe(1);
    });

    it("with the switch off, a profile proposal is neither refused at the limit nor recorded", async () => {
      const { tx, request } = await profileProposal();
      await setSwitch(false);
      await fillDailyLimit();

      await confirmCard(request.proposal.action);

      expect((await requestRows())[0].status).toBe("applied");
      expect(await tagsOf(tx)).toEqual([]);
      expect(await counted()).toBe(AI_DAILY_WRITE_LIMIT);
    });

    it("with the switch off, a proposal an agent built (not the profile's key) still counts and is refused at the limit", async () => {
      const { request } = await profileProposal();
      await setSwitch(false);
      await fillDailyLimit();
      // The same proposal, but submitted by an agent: another claim key.
      await db.query(`UPDATE ai_review_requests SET claimed_by = 'agent-1'`);

      await expect(confirmCard(request.proposal.action)).rejects.toMatchObject({
        status: 400,
      });
    });

    it("with the switch off, the AI-keyed automatic path still counts", async () => {
      const { request } = await profileProposal();
      await setSwitch(false);
      await db.query(
        `UPDATE ai_review_requests SET claimed_by = 'email-receipts-ai'`,
      );
      await confirmCard(request.proposal.action);
      expect(await counted()).toBe(1);
    });

    it("the exemption is the stored request's and the stored switch's: a client cannot ask for it", async () => {
      const { request } = await profileProposal();
      await setSwitch(true);
      await fillDailyLimit();
      const card = request.proposal.action;
      await expect(
        confirmCard({
          ...card,
          descriptor: { ...card.descriptor, exemptFromLimit: true },
        }),
      ).rejects.toBeDefined();
      await expect(confirmCard(card)).rejects.toMatchObject({ status: 400 });
    });

    it("answers by the real query: only a proposed request of the user's own mailbox is exempt", async () => {
      const { request } = await profileProposal();
      const requests = module.get(AiReviewRequestsService);
      await setSwitch(false);
      expect(
        await asAlice(() =>
          requests.isExemptFromWriteLimit(
            aliceId,
            request.id,
            "email-receipts",
          ),
        ),
      ).toBe(true);
      expect(
        await asBob(() =>
          requests.isExemptFromWriteLimit(bobId, request.id, "email-receipts"),
        ),
      ).toBe(false);
      await setSwitch(true);
      expect(
        await asAlice(() =>
          requests.isExemptFromWriteLimit(
            aliceId,
            request.id,
            "email-receipts",
          ),
        ),
      ).toBe(false);
    });
  });

  describe("approve selected (design 9)", () => {
    const proposeThree = async () => {
      await createParser(profile({ match: { by: ["reference"] } }));
      const txs: string[] = [];
      const ids: string[] = [];
      for (const [i, ref] of ["AAAA1111", "BBBB2222", "CCCC3333"].entries()) {
        txs.push(
          await createTx({
            amount: -15,
            date: `2026-09-1${i}`,
            description: `CARD ${ref}`,
          }),
        );
        ids.push(
          await insertEmail({
            body: ORDER_BODY.replace("PAYU*998877", ref),
            receivedAt: `2026-09-1${i}T10:00:00Z`,
          }),
        );
      }
      await asAlice(() => receipts.processBatch(aliceId, {}));
      const requests = await requestRows();
      return { txs, ids, requests };
    };

    it("commits each proposal through the same confirm, one transaction each, and reports one result per id", async () => {
      const { txs, requests } = await proposeThree();
      expect(requests).toHaveLength(3);
      expect(requests.every((r) => r.status === "proposed")).toBe(true);
      // one of them was dismissed meanwhile
      await db.query(
        `UPDATE ai_review_requests SET status = 'rejected' WHERE id = $1`,
        [requests[1].id],
      );

      const result = await asAlice(() =>
        approval.approveBatch(
          aliceId,
          requests.map((r) => r.id),
        ),
      );

      expect(result.approved).toBe(2);
      expect(result.failed).toBe(1);
      expect(result.results.map((r) => [r.id, r.ok])).toEqual([
        [requests[0].id, true],
        [requests[1].id, false],
        [requests[2].id, true],
      ]);
      expect(result.results[1].error).toMatch(/no longer waiting/);
      const after = await requestRows();
      expect(after.map((r) => r.status)).toEqual([
        "applied",
        "rejected",
        "applied",
      ]);
      const splitTx = await db.query(
        `SELECT transaction_id FROM transaction_splits GROUP BY transaction_id ORDER BY 1`,
      );
      expect(
        splitTx.map((r: { transaction_id: string }) => r.transaction_id).sort(),
      ).toEqual([txs[0], txs[2]].sort());
      // each approval is the card's own confirm: each spent its own claim
      const [{ n }] = await db.query(
        `SELECT COUNT(*)::int AS n FROM single_use_tokens WHERE purpose = 'ai-action'`,
      );
      expect(n).toBe(2);
    });

    it("rebuilds the card against the transaction as it is now: a changed transaction refuses that item only", async () => {
      const { txs, requests } = await proposeThree();
      await asAlice(() =>
        transactions.update(aliceId, txs[0], { amount: -20 } as never),
      );

      const result = await asAlice(() =>
        approval.approveBatch(
          aliceId,
          requests.map((r) => r.id),
        ),
      );

      expect(result.results[0]).toMatchObject({ ok: false });
      expect(result.results[0].error).toMatch(/add up to/);
      expect(result.results[1].ok).toBe(true);
      expect(result.results[2].ok).toBe(true);
      // the refused one wrote nothing
      expect((await requestRows())[0].status).toBe("proposed");
      expect(
        await db.query(
          `SELECT 1 FROM transaction_splits WHERE transaction_id = $1`,
          [txs[0]],
        ),
      ).toHaveLength(0);
    });

    it("counts each approval against the daily limit and refuses the ones past it, one by one", async () => {
      const { requests } = await proposeThree();
      await asAlice(() =>
        limiter.record(aliceId, "update_transaction", AI_DAILY_WRITE_LIMIT - 1),
      );

      const result = await asAlice(() =>
        approval.approveBatch(
          aliceId,
          requests.map((r) => r.id),
        ),
      );

      expect(result.results.map((r) => r.ok)).toEqual([true, false, false]);
      expect(result.results[1].error).toMatch(/Daily AI write limit/);
      expect((await requestRows()).map((r) => r.status)).toEqual([
        "applied",
        "proposed",
        "proposed",
      ]);
    });

    it("with the switch off the profile's approvals are not counted, so a whole page goes through at the limit", async () => {
      const { requests } = await proposeThree();
      await db.query(
        `UPDATE email_receipt_mailboxes SET profile_proposals_count_toward_ai_limit = false`,
      );
      await fillDailyLimit();

      const result = await asAlice(() =>
        approval.approveBatch(
          aliceId,
          requests.map((r) => r.id),
        ),
      );

      expect(result.approved).toBe(3);
    });

    it("another user's request reads as not found, and nothing of theirs is written", async () => {
      const { requests } = await proposeThree();
      const result = await asBob(() =>
        approval.approveBatch(bobId, [requests[0].id]),
      );
      expect(result.results[0]).toMatchObject({ ok: false });
      expect(result.results[0].error).toMatch(/not found/);
      expect((await requestRows())[0].status).toBe("proposed");
    });
  });
});
