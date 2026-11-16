import { ConflictException } from "@nestjs/common";
import { DataSource } from "typeorm";
import { LockScope } from "../common/db/locks";
import { createScopedDbMocks } from "../test-helpers/scoped-db-testing";
import {
  AiReviewRequest,
  MAX_PARSER_DRAFT_DOMAINS,
} from "./ai-review-request.entity";
import { AiReviewRequestsService } from "./ai-review-requests.service";

jest.mock("../common/db/scoped-db", () =>
  jest.requireActual("../test-helpers/scoped-db-testing").scopedDbMockModule(),
);

const USER = "user-1";
const TX_1 = "10000000-0000-4000-8000-000000000001";
const TX_2 = "10000000-0000-4000-8000-000000000002";
const RULE_1 = "20000000-0000-4000-8000-000000000001";
const RULE_2 = "20000000-0000-4000-8000-000000000002";

function setup() {
  const repo = { find: jest.fn().mockResolvedValue([]) };
  const { manager, dataSource } = createScopedDbMocks([
    [AiReviewRequest, repo],
  ]);
  const service = new AiReviewRequestsService(
    dataSource as unknown as DataSource,
  );
  return { service, manager, repo };
}

describe("AiReviewRequestsService.enqueue", () => {
  it("writes the whole batch in one parameterized INSERT ... ON CONFLICT DO NOTHING on the caller's manager", async () => {
    const { service, manager } = setup();
    manager.query.mockResolvedValue([
      { transaction_id: TX_1, rule_id: RULE_1 },
      { transaction_id: TX_2, rule_id: RULE_2 },
    ]);

    const result = await service.enqueue(manager as never, USER, [
      { transactionId: TX_1, ruleId: RULE_1, instruction: " one " },
      { transactionId: TX_2, ruleId: RULE_2, instruction: "two" },
    ]);

    expect(manager.query).toHaveBeenCalledTimes(1);
    const [sql, params] = manager.query.mock.calls[0];
    expect(sql).toMatch(/INSERT INTO ai_review_requests/);
    expect(sql).toMatch(
      /ON CONFLICT \(transaction_id, rule_id\)\s+WHERE status IN \('pending', 'claimed', 'proposed'\)\s+DO NOTHING/,
    );
    expect(sql).toMatch(/RETURNING transaction_id, rule_id/);
    expect(sql).not.toContain(TX_1);
    expect(params).toEqual([
      USER,
      [TX_1, TX_2],
      [RULE_1, RULE_2],
      ["one", "two"],
    ]);
    expect(result.queued).toEqual([
      { transactionId: TX_1, ruleId: RULE_1 },
      { transactionId: TX_2, ruleId: RULE_2 },
    ]);
    expect(result.alreadyQueued).toEqual([]);
  });

  it("reports a request the unique index skipped as already queued", async () => {
    const { service, manager } = setup();
    manager.query.mockResolvedValue([
      { transaction_id: TX_2, rule_id: RULE_2 },
    ]);

    const result = await service.enqueue(manager as never, USER, [
      { transactionId: TX_1, ruleId: RULE_1, instruction: "one" },
      { transactionId: TX_2, ruleId: RULE_2, instruction: "two" },
    ]);

    expect(result.queued).toEqual([{ transactionId: TX_2, ruleId: RULE_2 }]);
    expect(result.alreadyQueued).toEqual([
      { transactionId: TX_1, ruleId: RULE_1 },
    ]);
  });

  it("counts the second copy of a request inside one batch as already queued", async () => {
    const { service, manager } = setup();
    manager.query.mockResolvedValue([
      { transaction_id: TX_1, rule_id: RULE_1 },
    ]);

    const result = await service.enqueue(manager as never, USER, [
      { transactionId: TX_1, ruleId: RULE_1, instruction: "same" },
      { transactionId: TX_1, ruleId: RULE_1, instruction: "same" },
    ]);

    expect(result.queued).toHaveLength(1);
    expect(result.alreadyQueued).toHaveLength(1);
  });

  it("sends a request with no rule as a null in the rule array", async () => {
    const { service, manager } = setup();
    manager.query.mockResolvedValue([{ transaction_id: TX_1, rule_id: null }]);

    const result = await service.enqueue(manager as never, USER, [
      { transactionId: TX_1, ruleId: null, instruction: "manual" },
    ]);

    expect(manager.query.mock.calls[0][1][2]).toEqual([null]);
    expect(result.queued).toEqual([{ transactionId: TX_1, ruleId: null }]);
  });

  it("chunks a large batch so no statement carries an unbounded array", async () => {
    const { service, manager } = setup();
    manager.query.mockResolvedValue([]);
    const requests = Array.from({ length: 1001 }, () => ({
      transactionId: TX_1,
      ruleId: RULE_1,
      instruction: "x",
    }));

    await service.enqueue(manager as never, USER, requests);

    expect(manager.query.mock.calls.map((c) => c[1][1].length)).toEqual([
      500, 500, 1,
    ]);
  });

  it("issues no statement for an empty batch", async () => {
    const { service, manager } = setup();
    const result = await service.enqueue(manager as never, USER, []);
    expect(manager.query).not.toHaveBeenCalled();
    expect(result).toEqual({ queued: [], alreadyQueued: [] });
  });
});

describe("AiReviewRequestsService.claimNext", () => {
  const row = {
    id: "30000000-0000-4000-8000-000000000001",
    user_id: USER,
    transaction_id: TX_1,
    rule_id: RULE_1,
    kind: "transaction_review",
    instruction: "look",
    status: "claimed",
    claimed_by: "agent-1",
    claimed_at: new Date("2026-09-29T10:00:00Z"),
    proposal: null,
    created_at: new Date("2026-09-29T09:00:00Z"),
    updated_at: new Date("2026-09-29T10:00:00Z"),
    expires_at: new Date("2026-10-29T09:00:00Z"),
  };

  it("claims with ONE conditional UPDATE over a FOR UPDATE SKIP LOCKED subselect", async () => {
    const { service, manager } = setup();
    manager.query.mockResolvedValue([[row], 1]);

    const claimed = await service.claimNext(USER, "agent-1");

    expect(manager.query).toHaveBeenCalledTimes(1);
    const [sql, params] = manager.query.mock.calls[0];
    expect(sql).toMatch(/^UPDATE ai_review_requests/);
    expect(sql).toMatch(/SET status = 'claimed'/);
    expect(sql).toMatch(/FOR UPDATE SKIP LOCKED/);
    expect(sql).toMatch(
      /status = 'pending'\s+AND expires_at > CURRENT_TIMESTAMP/,
    );
    expect(sql).toMatch(/ORDER BY created_at, id/);
    expect(sql).toMatch(
      /AND status = 'pending'\s+AND user_id = \$1\s+RETURNING/,
    );
    expect(params).toEqual([USER, "agent-1"]);
    expect(claimed).toMatchObject({
      id: row.id,
      userId: USER,
      transactionId: TX_1,
      ruleId: RULE_1,
      status: "claimed",
      claimedBy: "agent-1",
    });
    expect(claimed).toBeInstanceOf(AiReviewRequest);
  });

  it("returns null when nothing is pending", async () => {
    const { service, manager } = setup();
    manager.query.mockResolvedValue([[], 0]);
    expect(await service.claimNext(USER, "agent-1")).toBeNull();
  });
});

describe("AiReviewRequestsService.listForUser", () => {
  it("filters by user and status, oldest first, with the limit clamped", async () => {
    const { service, repo } = setup();
    await service.listForUser(USER, { status: "pending", limit: 5000 });
    expect(repo.find).toHaveBeenCalledWith({
      where: { userId: USER, status: "pending" },
      order: { createdAt: "ASC", id: "ASC" },
      take: 200,
    });
  });

  it("defaults to every status and 50 rows", async () => {
    const { service, repo } = setup();
    await service.listForUser(USER);
    expect(repo.find).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: USER }, take: 50 }),
    );
  });
});

describe("AiReviewRequestsService.expireStale", () => {
  it("expires only open requests past their life and returns how many", async () => {
    const { service, manager } = setup();
    manager.query.mockResolvedValue([[{ id: "a" }, { id: "b" }], 2]);

    expect(await service.expireStale()).toBe(2);

    const [sql] = manager.query.mock.calls[0];
    expect(sql).toMatch(/SET status = 'expired'/);
    expect(sql).toMatch(/status IN \('pending', 'claimed', 'proposed'\)/);
    expect(sql).toMatch(/expires_at <= CURRENT_TIMESTAMP/);
  });
});

describe("AiReviewRequestsService.listForUser options", () => {
  it("takes several statuses, newest first, and leaves out expired requests on ask", async () => {
    const { service, repo } = setup();
    await service.listForUser(USER, {
      statuses: ["pending", "claimed", "proposed"],
      order: "DESC",
      unexpiredOnly: true,
    });
    const arg = repo.find.mock.calls[0][0];
    expect(arg.order).toEqual({ createdAt: "DESC", id: "DESC" });
    expect(arg.where.userId).toBe(USER);
    expect(arg.where.status.value).toEqual(["pending", "claimed", "proposed"]);
    expect(arg.where.expiresAt).toBeDefined();
  });
});

describe("AiReviewRequestsService.getForUser", () => {
  it("looks a request up by id AND user, so another user's id reads as absent", async () => {
    const { service, manager } = setup();
    const findOne = jest.fn().mockResolvedValue(null);
    manager.getRepository.mockReturnValue({ findOne });
    expect(await service.getForUser(USER, TX_1)).toBeNull();
    expect(findOne).toHaveBeenCalledWith({ where: { id: TX_1, userId: USER } });
  });
});

describe("the agent's conditional writes", () => {
  const row = {
    id: "30000000-0000-4000-8000-000000000001",
    user_id: USER,
    transaction_id: TX_1,
    rule_id: RULE_1,
    kind: "transaction_review",
    instruction: "look",
    status: "proposed",
    claimed_by: "agent-1",
    claimed_at: new Date("2026-09-29T09:00:00Z"),
    proposal: { input: {} },
    created_at: new Date("2026-09-29T09:00:00Z"),
    updated_at: new Date("2026-09-29T10:00:00Z"),
    expires_at: new Date("2026-10-29T09:00:00Z"),
  };

  it("submits only for the caller that holds the claim, in one conditional UPDATE", async () => {
    const { service, manager } = setup();
    manager.query.mockResolvedValue([[row], 1]);

    const stored = await service.submitProposal(USER, row.id, "agent-1", {
      input: { description: "x" },
    });

    expect(manager.query).toHaveBeenCalledTimes(1);
    const [sql, params] = manager.query.mock.calls[0];
    expect(sql).toMatch(/SET status = 'proposed'/);
    expect(sql).toMatch(
      /WHERE id = \$1\s+AND user_id = \$2\s+AND status = 'claimed'\s+AND claimed_by = \$3\s+AND expires_at > CURRENT_TIMESTAMP\s+RETURNING/,
    );
    expect(params).toEqual([
      row.id,
      USER,
      "agent-1",
      JSON.stringify({ input: { description: "x" } }),
    ]);
    expect(stored).toBeInstanceOf(AiReviewRequest);
    expect(stored?.status).toBe("proposed");
  });

  it("returns null, having written nothing, when the caller does not hold the claim", async () => {
    const { service, manager } = setup();
    manager.query.mockResolvedValue([[], 0]);
    expect(
      await service.submitProposal(USER, row.id, "agent-2", {}),
    ).toBeNull();
  });

  it("releases back to pending or closes the request, clearing the claim, only for the claimant", async () => {
    const { service, manager } = setup();
    manager.query.mockResolvedValue([[{ ...row, status: "pending" }], 1]);

    await service.release(USER, row.id, "agent-1", {
      final: false,
      note: "could not read the order",
    });

    const [sql, params] = manager.query.mock.calls[0];
    expect(sql).toMatch(
      /SET status = CASE WHEN \$4::boolean THEN 'rejected' ELSE 'pending' END,\s+claimed_by = NULL,\s+claimed_at = NULL/,
    );
    expect(sql).toMatch(
      /WHERE id = \$1\s+AND user_id = \$2\s+AND status = 'claimed'\s+AND claimed_by = \$3/,
    );
    expect(params).toEqual([
      row.id,
      USER,
      "agent-1",
      false,
      "could not read the order",
    ]);
  });

  it("bounds the note an agent leaves", async () => {
    const { service, manager } = setup();
    manager.query.mockResolvedValue([[], 0]);
    await service.release(USER, row.id, "agent-1", {
      final: true,
      note: "x".repeat(2000),
    });
    expect(manager.query.mock.calls[0][1][4]).toHaveLength(500);
  });

  it("dismisses only an open request of the user's", async () => {
    const { service, manager } = setup();
    manager.query.mockResolvedValue([[{ ...row, status: "rejected" }], 1]);
    const dismissed = await service.dismiss(USER, row.id);
    const [sql, params] = manager.query.mock.calls[0];
    expect(sql).toMatch(/SET status = 'rejected'/);
    expect(sql).toMatch(/status IN \('pending', 'claimed', 'proposed'\)/);
    expect(params).toEqual([row.id, USER]);
    expect(dismissed?.status).toBe("rejected");

    manager.query.mockResolvedValue([[], 0]);
    expect(await service.dismiss(USER, row.id)).toBeNull();
  });

  it("marks applied on the CALLER's manager, bound to the user and the transaction, from proposed only", async () => {
    const { service, manager } = setup();
    manager.query.mockResolvedValue([[{ id: row.id }], 1]);

    await service.markApplied(manager as never, USER, row.id, TX_1);

    const [sql, params] = manager.query.mock.calls[0];
    expect(sql).toMatch(/SET status = 'applied'/);
    expect(sql).toMatch(
      /WHERE id = \$1\s+AND user_id = \$2\s+AND transaction_id = \$3\s+AND status = 'proposed'/,
    );
    expect(params).toEqual([row.id, USER, TX_1]);
  });

  it("refuses with a conflict when nothing is waiting for approval, so the caller's write rolls back", async () => {
    const { service, manager } = setup();
    manager.query.mockResolvedValue([[], 0]);
    await expect(
      service.markApplied(manager as never, USER, row.id, TX_1),
    ).rejects.toMatchObject({ status: 409 });
  });
});

describe("AiReviewRequestsService.enqueueClaimed", () => {
  const RECEIPT = "40000000-0000-4000-8000-000000000001";
  const row = (over: Record<string, unknown> = {}) => ({
    id: "50000000-0000-4000-8000-000000000001",
    user_id: USER,
    transaction_id: TX_1,
    rule_id: null,
    kind: "email_receipt",
    instruction: "Enrich from the order email",
    status: "claimed",
    claimed_by: "email-receipts",
    claimed_at: new Date("2026-09-30T10:00:00Z"),
    proposal: null,
    created_at: new Date("2026-09-30T10:00:00Z"),
    updated_at: new Date("2026-09-30T10:00:00Z"),
    expires_at: new Date("2026-10-30T10:00:00Z"),
    email_receipt_id: RECEIPT,
    ...over,
  });
  const input = {
    transactionId: TX_1,
    kind: "email_receipt" as const,
    emailReceiptId: RECEIPT,
    instruction: " Enrich from the order email ",
    claimedBy: "email-receipts",
  };

  it("writes one claimed request with the email it was raised for, on the caller's manager", async () => {
    const { service, manager } = setup();
    manager.query.mockResolvedValueOnce([]).mockResolvedValueOnce([row()]);

    const created = await service.enqueueClaimed(manager as never, USER, input);

    expect(created).toMatchObject({
      kind: "email_receipt",
      status: "claimed",
      claimedBy: "email-receipts",
      emailReceiptId: RECEIPT,
      ruleId: null,
    });
    const [insertSql, params] = manager.query.mock.calls[1];
    expect(insertSql).toMatch(/INSERT INTO ai_review_requests/);
    expect(insertSql).toMatch(/email_receipt_id/);
    expect(insertSql).toMatch(
      /ON CONFLICT \(transaction_id, rule_id\)\s+WHERE status IN \('pending', 'claimed', 'proposed'\)\s+DO NOTHING/,
    );
    expect(insertSql).toMatch(/RETURNING \*/);
    expect(insertSql).not.toContain(TX_1);
    expect(params).toEqual([
      USER,
      TX_1,
      "email_receipt",
      "Enrich from the order email",
      "claimed",
      "email-receipts",
      RECEIPT,
    ]);
  });

  it("takes the transaction's advisory lock before it looks for an open request", async () => {
    const { service, manager } = setup();
    manager.query.mockResolvedValue([]);

    await service.enqueueClaimed(manager as never, USER, input);

    const [lockSql, lockParams] = manager.query.mock.calls[0];
    expect(lockSql).toMatch(/pg_advisory_xact_lock/);
    expect(lockParams).toEqual([LockScope.AiReviewRequests, TX_1]);
    expect(manager.query.mock.calls[1][0]).toMatch(/INSERT INTO/);
  });

  it("excludes a transaction that already has an open, unexpired request with no rule, since the unique index does not see NULL rules", async () => {
    const { service, manager } = setup();
    manager.query.mockResolvedValue([]);

    const created = await service.enqueueClaimed(manager as never, USER, input);

    expect(created).toBeNull();
    const sql = manager.query.mock.calls[1][0] as string;
    expect(sql).toMatch(/WHERE NOT EXISTS/);
    expect(sql).toMatch(/open_request\.rule_id IS NULL/);
    expect(sql).toMatch(
      /open_request\.status IN \('pending', 'claimed', 'proposed'\)/,
    );
    expect(sql).toMatch(/open_request\.expires_at > CURRENT_TIMESTAMP/);
    expect(sql).toMatch(/open_request\.user_id = \$1::uuid/);
  });

  it("cuts an instruction to the column's bound", async () => {
    const { service, manager } = setup();
    manager.query.mockResolvedValue([]);

    await service.enqueueClaimed(manager as never, USER, {
      ...input,
      instruction: "y".repeat(2000),
    });

    expect(manager.query.mock.calls[1][1][3]).toHaveLength(1000);
  });
});

describe("AiReviewRequestsService.enqueuePendingForReceipt", () => {
  it("writes a pending, unclaimed request of kind email_receipt and reports a duplicate as null", async () => {
    const { service, manager } = setup();
    manager.query.mockResolvedValue([]);

    const created = await service.enqueuePendingForReceipt(
      manager as never,
      USER,
      {
        transactionId: TX_1,
        emailReceiptId: "40000000-0000-4000-8000-000000000001",
        instruction: "Enrich",
      },
    );

    expect(created).toBeNull();
    expect(manager.query.mock.calls[1][1]).toEqual([
      USER,
      TX_1,
      "email_receipt",
      "Enrich",
      "pending",
      null,
      "40000000-0000-4000-8000-000000000001",
    ]);
  });
});

describe("AiReviewRequestsService.claimById", () => {
  const claimedRow = {
    id: "50000000-0000-4000-8000-000000000001",
    user_id: USER,
    transaction_id: TX_1,
    rule_id: null,
    kind: "email_receipt",
    instruction: "Enrich",
    status: "claimed",
    claimed_by: "email-receipts-ai",
    claimed_at: new Date(),
    proposal: null,
    created_at: new Date(),
    updated_at: new Date(),
    expires_at: new Date(),
    email_receipt_id: "40000000-0000-4000-8000-000000000001",
  };

  it("claims the named request in one conditional UPDATE bound to the user, to pending and to its life", async () => {
    const { service, manager } = setup();
    manager.query.mockResolvedValue([claimedRow]);

    const claimed = await service.claimById(
      USER,
      claimedRow.id,
      "email-receipts-ai",
    );

    expect(claimed).toMatchObject({
      id: claimedRow.id,
      status: "claimed",
      claimedBy: "email-receipts-ai",
      emailReceiptId: claimedRow.email_receipt_id,
    });
    const [sql, params] = manager.query.mock.calls[0];
    expect(sql).toMatch(/UPDATE ai_review_requests/);
    expect(sql).toMatch(
      /WHERE id = \$1\s+AND user_id = \$2\s+AND status = 'pending'/,
    );
    expect(sql).toMatch(/expires_at > CURRENT_TIMESTAMP/);
    expect(params).toEqual([claimedRow.id, USER, "email-receipts-ai"]);
  });

  it("is null when the request is not pending, not the user's, or expired", async () => {
    const { service, manager } = setup();
    manager.query.mockResolvedValue([]);
    await expect(
      service.claimById(USER, claimedRow.id, "email-receipts-ai"),
    ).resolves.toBeNull();
  });
});

describe("AiReviewRequestsService row mapping", () => {
  it("maps email_receipt_id, and reads it as null when a row omits it", async () => {
    const { service, manager } = setup();
    const base = {
      id: "a",
      user_id: USER,
      transaction_id: TX_1,
      rule_id: RULE_1,
      kind: "transaction_review",
      instruction: "x",
      status: "claimed",
      claimed_by: "k",
      claimed_at: new Date(),
      proposal: null,
      created_at: new Date(),
      updated_at: new Date(),
      expires_at: new Date(),
    };
    manager.query.mockResolvedValueOnce([
      { ...base, email_receipt_id: "40000000-0000-4000-8000-000000000001" },
    ]);
    manager.query.mockResolvedValueOnce([base]);

    const first = await service.claimNext(USER, "k");
    const second = await service.claimNext(USER, "k");

    expect(first?.emailReceiptId).toBe("40000000-0000-4000-8000-000000000001");
    expect(second?.emailReceiptId).toBeNull();
  });
});

describe("AiReviewRequestsService.enqueueParserDraft", () => {
  const R1 = "40000000-0000-4000-8000-000000000001";
  const R2 = "40000000-0000-4000-8000-000000000002";
  const row = (over: Record<string, unknown> = {}) => ({
    id: "60000000-0000-4000-8000-000000000001",
    user_id: USER,
    transaction_id: null,
    rule_id: null,
    kind: "email_parser_draft",
    instruction: "Write a parser",
    status: "pending",
    claimed_by: null,
    claimed_at: null,
    proposal: null,
    created_at: new Date("2026-10-03T10:00:00Z"),
    updated_at: new Date("2026-10-03T10:00:00Z"),
    expires_at: new Date("2026-11-02T10:00:00Z"),
    email_receipt_id: null,
    email_receipt_ids: [R1, R2],
    parser_domain: "shop.example.com",
    ...over,
  });
  const input = {
    emailReceiptIds: [R1, R2],
    parserDomain: "shop.example.com",
    instruction: " Write a parser ",
  };

  it("serialises on the user and sender, expires and closes what is open for that sender, then inserts, in the caller's transaction", async () => {
    const { service, manager } = setup();
    manager.query.mockResolvedValue([row()]);

    const created = await service.enqueueParserDraft(
      manager as never,
      USER,
      input,
    );

    const statements = manager.query.mock.calls.map((c) => String(c[0]));
    expect(statements[0]).toContain("pg_advisory_xact_lock");
    expect(manager.query.mock.calls[0][1]).toEqual([
      LockScope.AiParserDraftRequests,
      `${USER}:shop.example.com`,
    ]);
    expect(statements[1]).toMatch(/SET status = 'expired'/);
    expect(statements[1]).toMatch(/expires_at <= CURRENT_TIMESTAMP/);
    expect(statements[2]).toMatch(/SET status = 'rejected'/);
    expect(statements[2]).toMatch(/kind = 'email_parser_draft'/);
    expect(statements[2]).toMatch(/parser_domain = \$2/);
    expect(statements[3]).toMatch(/INSERT INTO ai_review_requests/);
    expect(manager.query.mock.calls[3][1]).toEqual([
      USER,
      "Write a parser",
      [R1, R2],
      "shop.example.com",
    ]);
    expect(created).toMatchObject({
      kind: "email_parser_draft",
      status: "pending",
      transactionId: null,
      emailReceiptIds: [R1, R2],
      parserDomain: "shop.example.com",
    });
    // never keyed on a request-supplied user
    for (const statement of statements.slice(1, 3)) {
      expect(statement).toMatch(/user_id = \$1/);
    }
  });

  it("closes the open request before it inserts the new one", async () => {
    const { service, manager } = setup();
    manager.query.mockResolvedValue([row()]);

    await service.enqueueParserDraft(manager as never, USER, input);

    const order = manager.query.mock.calls.map((c) => String(c[0]));
    expect(order.findIndex((s) => s.includes("'rejected'"))).toBeLessThan(
      order.findIndex((s) => s.includes("INSERT INTO")),
    );
  });

  it("cuts the instruction to the column's bound", async () => {
    const { service, manager } = setup();
    manager.query.mockResolvedValue([row()]);

    await service.enqueueParserDraft(manager as never, USER, {
      ...input,
      instruction: "x".repeat(2000),
    });

    expect((manager.query.mock.calls[3][1] as unknown[])[1]).toHaveLength(1000);
  });

  it.each([[[]], [Array.from({ length: 26 }, () => R1)]])(
    "refuses %j emails before touching the database",
    async (ids) => {
      const { service, manager } = setup();

      await expect(
        service.enqueueParserDraft(manager as never, USER, {
          ...input,
          emailReceiptIds: ids,
        }),
      ).rejects.toThrow();

      expect(manager.query).not.toHaveBeenCalled();
    },
  );
});

describe("AiReviewRequestsService.queueParserDraft", () => {
  const R1 = "40000000-0000-4000-8000-000000000001";
  const OPEN = "60000000-0000-4000-8000-000000000001";
  const row = (over: Record<string, unknown> = {}) => ({
    id: OPEN,
    user_id: USER,
    transaction_id: null,
    rule_id: null,
    kind: "email_parser_draft",
    instruction: "New text",
    status: "pending",
    claimed_by: null,
    claimed_at: null,
    proposal: null,
    created_at: new Date("2026-10-03T10:00:00Z"),
    updated_at: new Date("2026-10-03T10:00:00Z"),
    expires_at: new Date("2026-11-02T10:00:00Z"),
    email_receipt_id: null,
    email_receipt_ids: [R1],
    parser_domain: "shop.example.com",
    ...over,
  });
  const input = {
    emailReceiptIds: [R1],
    parserDomain: "shop.example.com",
    instruction: " New text ",
  };

  it("replaces an open UNCLAIMED request in place, under the sender's lock, keeping its id", async () => {
    const { service, manager } = setup();
    manager.query
      .mockResolvedValueOnce([]) // the advisory lock
      .mockResolvedValueOnce([{ id: OPEN, status: "pending" }])
      .mockResolvedValueOnce([row()]);

    const request = await service.queueParserDraft(
      manager as never,
      USER,
      input,
    );

    const statements = manager.query.mock.calls.map((c) => String(c[0]));
    expect(statements[0]).toContain("pg_advisory_xact_lock");
    expect(manager.query.mock.calls[0][1]).toEqual([
      LockScope.AiParserDraftRequests,
      `${USER}:shop.example.com`,
    ]);
    expect(statements[1]).toMatch(/FOR UPDATE/);
    expect(statements[1]).toMatch(/status IN \('pending', 'claimed'\)/);
    expect(statements[2]).toMatch(/SET instruction = \$3::text/);
    expect(statements[2]).toMatch(/status = 'pending'/);
    expect(statements[2]).toMatch(/user_id = \$2/);
    expect(manager.query.mock.calls[2][1]).toEqual([
      OPEN,
      USER,
      "New text",
      [R1],
    ]);
    expect(statements.some((s) => s.includes("INSERT INTO"))).toBe(false);
    expect(request.id).toBe(OPEN);
  });

  it("refuses with a 409 when an agent has claimed the open request, writing nothing", async () => {
    const { service, manager } = setup();
    manager.query
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ id: OPEN, status: "claimed" }]);

    await expect(
      service.queueParserDraft(manager as never, USER, input),
    ).rejects.toBeInstanceOf(ConflictException);

    const statements = manager.query.mock.calls.map((c) => String(c[0]));
    expect(statements.some((s) => /^\s*(UPDATE|INSERT)/.test(s))).toBe(false);
  });

  it("refuses when the replacing UPDATE matches nothing (the row left pending)", async () => {
    const { service, manager } = setup();
    manager.query
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ id: OPEN, status: "pending" }])
      .mockResolvedValueOnce([]);

    await expect(
      service.queueParserDraft(manager as never, USER, input),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it("queues a new request when none is open or unclaimed (a proposed one is closed by the insert path)", async () => {
    const { service, manager } = setup();
    manager.query
      .mockResolvedValueOnce([]) // lock
      .mockResolvedValueOnce([]) // nothing pending or claimed
      .mockResolvedValue([row()]);

    const request = await service.queueParserDraft(
      manager as never,
      USER,
      input,
    );

    const statements = manager.query.mock.calls.map((c) => String(c[0]));
    expect(statements.some((s) => s.includes("SET status = 'rejected'"))).toBe(
      true,
    );
    expect(statements.some((s) => s.includes("INSERT INTO"))).toBe(true);
    expect(request.kind).toBe("email_parser_draft");
  });

  it("cuts the replacing instruction to the column's bound", async () => {
    const { service, manager } = setup();
    manager.query
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ id: OPEN, status: "pending" }])
      .mockResolvedValueOnce([row()]);

    await service.queueParserDraft(manager as never, USER, {
      ...input,
      instruction: "x".repeat(2000),
    });

    expect((manager.query.mock.calls[2][1] as unknown[])[2]).toHaveLength(1000);
  });

  it("refuses 0 or 6 emails before touching the database", async () => {
    const { service, manager } = setup();
    await expect(
      service.queueParserDraft(manager as never, USER, {
        ...input,
        emailReceiptIds: [],
      }),
    ).rejects.toThrow();
    await expect(
      service.queueParserDraft(manager as never, USER, {
        ...input,
        emailReceiptIds: [R1, R1, R1, R1, R1, R1],
      }),
    ).rejects.toThrow();
    expect(manager.query).not.toHaveBeenCalled();
  });
});

describe("AiReviewRequestsService the parser draft lifecycle", () => {
  const REQUEST = "60000000-0000-4000-8000-000000000001";
  const PARSER = "70000000-0000-4000-8000-000000000001";

  it("proposes with ONE conditional UPDATE: claimed by this caller, of this kind, alive", async () => {
    const { service, manager } = setup();
    manager.query.mockResolvedValue([{ id: REQUEST }]);

    await expect(
      service.proposeParserDraft(
        manager as never,
        USER,
        REQUEST,
        "assistant",
        PARSER,
      ),
    ).resolves.toBe(true);

    const [sql, params] = manager.query.mock.calls[0];
    expect(sql).toMatch(/SET status = 'proposed'/);
    expect(sql).toMatch(/kind = 'email_parser_draft'/);
    expect(sql).toMatch(/q\.status = 'claimed'/);
    expect(sql).toMatch(/claimed_by = \$3/);
    expect(sql).toMatch(/expires_at > CURRENT_TIMESTAMP/);
    // The first draft stays `parserId`; every draft is appended to `parserIds`.
    expect(sql).toMatch(
      /'parserId', COALESCE\(q\.proposal ->> 'parserId', \$4::text\)/,
    );
    expect(sql).toMatch(/'parserIds'/);
    // A proposed request takes another draft only when it spans several domains.
    expect(sql).toMatch(/q\.status = 'proposed'/);
    expect(sql).toMatch(/COUNT\(DISTINCT r\.from_domain\)/);
    expect(sql).not.toContain(PARSER);
    expect(params).toEqual([
      REQUEST,
      USER,
      "assistant",
      PARSER,
      MAX_PARSER_DRAFT_DOMAINS,
    ]);
  });

  it("does not propose for a caller that does not hold the claim", async () => {
    const { service, manager } = setup();
    manager.query.mockResolvedValue([]);

    await expect(
      service.proposeParserDraft(
        manager as never,
        USER,
        REQUEST,
        "other",
        PARSER,
      ),
    ).resolves.toBe(false);
  });

  it("marks applied the proposed requests that proposed this parser, and counts them", async () => {
    const { service, manager } = setup();
    manager.query.mockResolvedValue([{ id: "a" }, { id: "b" }]);

    await expect(
      service.markParserDraftApplied(manager as never, USER, PARSER),
    ).resolves.toBe(2);

    const [sql, params] = manager.query.mock.calls[0];
    expect(sql).toMatch(/SET status = 'applied'/);
    expect(sql).toMatch(/kind = 'email_parser_draft'/);
    expect(sql).toMatch(/status = 'proposed'/);
    // Every parser the request lists must be an approved parser of the user's.
    expect(sql).toMatch(/q\.proposal -> 'parserIds'/);
    expect(sql).toMatch(/q\.proposal ->> 'parserId'/);
    expect(sql).toMatch(/p\.status = 'approved'/);
    expect(params).toEqual([USER, PARSER]);
  });

  it("marking applied with nothing matching is not an error (a draft written by hand)", async () => {
    const { service, manager } = setup();
    manager.query.mockResolvedValue([]);

    await expect(
      service.markParserDraftApplied(manager as never, USER, PARSER),
    ).resolves.toBe(0);
  });

  it("dismisses the open requests that proposed a deleted parser", async () => {
    const { service, manager } = setup();
    manager.query.mockResolvedValue([{ id: "a" }]);

    await expect(
      service.dismissParserDraftsFor(manager as never, USER, PARSER),
    ).resolves.toBe(1);

    const [sql, params] = manager.query.mock.calls[0];
    expect(sql).toMatch(/SET status = 'rejected'/);
    expect(sql).toMatch(/status IN \('pending', 'claimed', 'proposed'\)/);
    // Rejected only when none of the parsers the request lists exists any more.
    expect(sql).toMatch(/NOT EXISTS/);
    expect(sql).toMatch(/JOIN email_receipt_parsers p/);
    expect(params).toEqual([USER, PARSER]);
  });

  it("markApplied for a transaction never matches a parser draft (no transaction id)", async () => {
    const { service, manager } = setup();
    manager.query.mockResolvedValue([]);

    await expect(
      service.markApplied(manager as never, USER, REQUEST, TX_1),
    ).rejects.toThrow();

    expect(String(manager.query.mock.calls[0][0])).toMatch(
      /transaction_id = \$3/,
    );
  });

  it("maps the parser-draft columns, and reads them as null for a row that omits them", async () => {
    const { service, manager } = setup();
    const base = {
      id: "a",
      user_id: USER,
      transaction_id: TX_1,
      rule_id: RULE_1,
      kind: "transaction_review",
      instruction: "x",
      status: "claimed",
      claimed_by: "k",
      claimed_at: new Date(),
      proposal: null,
      created_at: new Date(),
      updated_at: new Date(),
      expires_at: new Date(),
    };
    manager.query.mockResolvedValueOnce([
      {
        ...base,
        transaction_id: null,
        kind: "email_parser_draft",
        email_receipt_ids: ["r1"],
        parser_domain: "shop.example.com",
      },
    ]);
    manager.query.mockResolvedValueOnce([base]);

    const draft = await service.claimNext(USER, "k");
    const other = await service.claimNext(USER, "k");

    expect(draft).toMatchObject({
      transactionId: null,
      emailReceiptIds: ["r1"],
      parserDomain: "shop.example.com",
    });
    expect(other).toMatchObject({ emailReceiptIds: null, parserDomain: null });
  });
});

describe("AiReviewRequestsService.isExemptFromWriteLimit (email-receipts design 7.1)", () => {
  const REQUEST = "30000000-0000-4000-8000-000000000001";
  const KEY = "email-receipts";

  it("is exempt only when the stored switch is off for a proposed request submitted under the profile's key", async () => {
    const { service, manager } = setup();
    manager.query.mockResolvedValue([{ counts: false }]);

    await expect(
      service.isExemptFromWriteLimit(USER, REQUEST, KEY),
    ).resolves.toBe(true);

    const [sql, params] = manager.query.mock.calls[0];
    expect(String(sql)).toContain("profile_proposals_count_toward_ai_limit");
    expect(String(sql)).toContain("r.kind = 'email_receipt'");
    expect(String(sql)).toContain("r.status = 'proposed'");
    expect(String(sql)).toContain("r.claimed_by = $3");
    expect(String(sql)).toContain("r.user_id = $2");
    expect(String(sql)).toContain(
      "JOIN email_receipt_mailboxes mb ON mb.user_id = r.user_id",
    );
    expect(params).toEqual([REQUEST, USER, KEY]);
    // A read: it never writes the request or the mailbox.
    expect(String(sql).trim()).toMatch(/^SELECT/);
  });

  it("counts (not exempt) while the switch is on, which is the default", async () => {
    const { service, manager } = setup();
    manager.query.mockResolvedValue([{ counts: true }]);
    await expect(
      service.isExemptFromWriteLimit(USER, REQUEST, KEY),
    ).resolves.toBe(false);
  });

  it.each([
    [
      "a request that is not found, is another user's, is another kind or key, or is not proposed",
      [],
    ],
  ])("counts for %s", async (_label, rows) => {
    const { service, manager } = setup();
    manager.query.mockResolvedValue(rows);
    await expect(
      service.isExemptFromWriteLimit(USER, REQUEST, KEY),
    ).resolves.toBe(false);
  });

  it("counts when the switch reads as anything but false (a null is no information)", async () => {
    const { service, manager } = setup();
    manager.query.mockResolvedValue([{ counts: null }]);
    await expect(
      service.isExemptFromWriteLimit(USER, REQUEST, KEY),
    ).resolves.toBe(false);
  });
});

describe("AiReviewRequestsService trade requests (email_trade)", () => {
  const RECEIPT = "40000000-0000-4000-8000-000000000001";
  const REQUEST = "50000000-0000-4000-8000-000000000002";
  const tradeRow = (over: Record<string, unknown> = {}) => ({
    id: REQUEST,
    user_id: USER,
    transaction_id: null,
    rule_id: null,
    kind: "email_trade",
    instruction: "A trade confirmation proposes this investment transaction",
    status: "claimed",
    claimed_by: "email-receipts",
    claimed_at: new Date("2026-10-15T10:00:00Z"),
    proposal: null,
    created_at: new Date("2026-10-15T10:00:00Z"),
    updated_at: new Date("2026-10-15T10:00:00Z"),
    expires_at: new Date("2026-11-14T10:00:00Z"),
    email_receipt_id: RECEIPT,
    ...over,
  });
  const input = {
    emailReceiptId: RECEIPT,
    instruction: " A trade confirmation proposes this investment transaction ",
    claimedBy: "email-receipts",
  };

  it("queues one claimed request for the email, with no transaction and no rule, on the caller's manager", async () => {
    const { service, manager } = setup();
    manager.query.mockResolvedValueOnce([tradeRow()]);

    const created = await service.enqueueTrade(manager as never, USER, input);

    expect(created).toMatchObject({
      kind: "email_trade",
      status: "claimed",
      claimedBy: "email-receipts",
      emailReceiptId: RECEIPT,
      transactionId: null,
      ruleId: null,
    });
    const [sql, params] = manager.query.mock.calls[0];
    expect(sql).toMatch(/INSERT INTO ai_review_requests/);
    expect(sql).toMatch(/'email_trade'/);
    // The index that holds "one open trade request per email" is the arbiter.
    expect(sql).toMatch(
      /ON CONFLICT \(email_receipt_id\)\s+WHERE kind = 'email_trade' AND status IN \('pending', 'claimed', 'proposed'\)\s+DO NOTHING/,
    );
    expect(params).toEqual([
      USER,
      "A trade confirmation proposes this investment transaction",
      "email-receipts",
      RECEIPT,
    ]);
  });

  it("queues it pending, unclaimed, when no claim key is given (Recognize as a trade)", async () => {
    const { service, manager } = setup();
    manager.query.mockResolvedValueOnce([
      tradeRow({ status: "pending", claimed_by: null, claimed_at: null }),
    ]);
    const created = await service.enqueueTrade(manager as never, USER, {
      ...input,
      claimedBy: null,
    });
    expect(created).toMatchObject({ status: "pending", claimedBy: null });
    const [sql, params] = manager.query.mock.calls[0];
    expect(sql).toMatch(/CASE WHEN \$3::text IS NULL THEN 'pending'/);
    expect(params[2]).toBeNull();
  });

  it("returns null when the email already has an open trade request", async () => {
    const { service, manager } = setup();
    manager.query.mockResolvedValueOnce([]);
    expect(
      await service.enqueueTrade(manager as never, USER, input),
    ).toBeNull();
  });

  it("marks the request applied only while it is a proposed, unexpired trade request of the user", async () => {
    const { service, manager } = setup();
    manager.query.mockResolvedValue([[{ id: REQUEST }], 1]);

    await service.markTradeApplied(manager as never, USER, REQUEST);

    const [sql, params] = manager.query.mock.calls[0];
    expect(sql).toMatch(/SET status = 'applied'/);
    expect(sql).toMatch(
      /WHERE id = \$1\s+AND user_id = \$2\s+AND kind = 'email_trade'\s+AND status = 'proposed'\s+AND expires_at > CURRENT_TIMESTAMP/,
    );
    expect(params).toEqual([REQUEST, USER]);
  });

  it("refuses with a conflict when it was dismissed or expired since the card was built, so the creation rolls back", async () => {
    const { service, manager } = setup();
    manager.query.mockResolvedValue([[], 0]);
    await expect(
      service.markTradeApplied(manager as never, USER, REQUEST),
    ).rejects.toMatchObject({ status: 409 });
  });
});
