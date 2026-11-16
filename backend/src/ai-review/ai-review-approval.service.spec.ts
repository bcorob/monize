import "reflect-metadata";
import { GUARDS_METADATA } from "@nestjs/common/constants";
import { BadRequestException, ConflictException, Logger } from "@nestjs/common";
import { plainToInstance } from "class-transformer";
import { validate } from "class-validator";
import { ALLOW_DELEGATE_KEY } from "../delegation/decorators/delegate-access.decorator";
import { AiReviewApprovalController } from "./ai-review-approval.controller";
import {
  AI_REVIEW_APPROVE_BATCH_MAX,
  AiReviewApprovalService,
} from "./ai-review-approval.service";
import { ApproveAiReviewBatchDto } from "./dto/approve-ai-review-batch.dto";

/**
 * "Approve selected" (design 9): each request is rebuilt by the inbox's own card
 * path and committed through the SAME confirm a single approval uses.
 */

const USER = "user-1";
const id = (n: number) =>
  `30000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

const cardFor = (n: number) => ({
  action: {
    actionId: `action-${n}`,
    type: "update_transaction",
    signature: `sig-${n}`,
    descriptor: { type: "update_transaction", actionId: `action-${n}` },
    preview: {},
    expiresAt: 1,
  },
});

function setup() {
  const work = { buildApprovalCard: jest.fn() };
  const actions = { confirm: jest.fn().mockResolvedValue({ id: "tx" }) };
  const service = new AiReviewApprovalService(work as never, actions as never);
  work.buildApprovalCard.mockImplementation(async (_u: string, rid: string) =>
    cardFor(Number(rid.slice(-12))),
  );
  return { service, work, actions };
}

beforeEach(() => jest.spyOn(Logger.prototype, "warn").mockImplementation());
afterEach(() => jest.restoreAllMocks());

describe("AiReviewApprovalService.approveBatch", () => {
  it("commits each rebuilt card through confirm, in the order given, one after the other", async () => {
    const { service, work, actions } = setup();
    const order: string[] = [];
    actions.confirm.mockImplementation(
      async (_u: string, dto: { actionId: string }) => {
        order.push(`start ${dto.actionId}`);
        await new Promise((resolve) => setTimeout(resolve, 3));
        order.push(`end ${dto.actionId}`);
        return { id: "tx" };
      },
    );

    const result = await service.approveBatch(USER, [id(2), id(1), id(3)]);

    expect(work.buildApprovalCard.mock.calls.map((c) => c[1])).toEqual([
      id(2),
      id(1),
      id(3),
    ]);
    expect(order).toEqual([
      "start action-2",
      "end action-2",
      "start action-1",
      "end action-1",
      "start action-3",
      "end action-3",
    ]);
    expect(result).toEqual({
      results: [
        { id: id(2), ok: true },
        { id: id(1), ok: true },
        { id: id(3), ok: true },
      ],
      approved: 3,
      failed: 0,
    });
  });

  it("hands confirm exactly the card's action id, signature and descriptor (preview == commit)", async () => {
    const { service, actions } = setup();
    await service.approveBatch(USER, [id(7)]);
    expect(actions.confirm).toHaveBeenCalledWith(USER, {
      actionId: "action-7",
      signature: "sig-7",
      descriptor: { type: "update_transaction", actionId: "action-7" },
    });
  });

  it("reports a request with no buildable card and goes on, without calling confirm for it", async () => {
    const { service, work, actions } = setup();
    work.buildApprovalCard.mockImplementation(
      async (_u: string, rid: string) =>
        rid === id(2)
          ? { error: "No longer waiting for approval" }
          : cardFor(Number(rid.slice(-12))),
    );

    const result = await service.approveBatch(USER, [id(1), id(2), id(3)]);

    expect(result.results).toEqual([
      { id: id(1), ok: true },
      { id: id(2), ok: false, error: "No longer waiting for approval" },
      { id: id(3), ok: true },
    ]);
    expect(result).toMatchObject({ approved: 2, failed: 1 });
    expect(actions.confirm).toHaveBeenCalledTimes(2);
  });

  it("reports a refusal by confirm (the write limit, a reconciled lock, a spent claim) with its message, and the others still go through", async () => {
    const { service, actions } = setup();
    actions.confirm
      .mockResolvedValueOnce({ id: "tx" })
      .mockRejectedValueOnce(
        new BadRequestException(
          "Daily AI write limit reached. Please try again tomorrow.",
        ),
      )
      .mockRejectedValueOnce(
        new ConflictException("No longer waiting for approval"),
      )
      .mockResolvedValueOnce({ id: "tx" });

    const result = await service.approveBatch(USER, [
      id(1),
      id(2),
      id(3),
      id(4),
    ]);

    expect(result.results.map((r) => [r.ok, r.error])).toEqual([
      [true, undefined],
      [false, "Daily AI write limit reached. Please try again tomorrow."],
      [false, "No longer waiting for approval"],
      [true, undefined],
    ]);
    expect(result).toMatchObject({ approved: 2, failed: 2 });
  });

  it("does not show an internal error's text: it says the proposal could not be approved and logs only the class", async () => {
    const { service, actions } = setup();
    const warn = jest.spyOn(Logger.prototype, "warn").mockImplementation();
    actions.confirm.mockRejectedValueOnce(
      new Error("connection string postgres://secret"),
    );

    const result = await service.approveBatch(USER, [id(1)]);

    expect(result.results[0]).toMatchObject({ id: id(1), ok: false });
    expect(result.results[0].error).toMatch(/could not be approved/);
    expect(JSON.stringify(result)).not.toContain("secret");
    const logged = warn.mock.calls.map((c) => String(c[0])).join("\n");
    expect(logged).toContain("Error");
    expect(logged).not.toContain("secret");
  });

  it("answers an id twice once, and never more than the bound", async () => {
    const { service, actions } = setup();
    const many = Array.from(
      { length: AI_REVIEW_APPROVE_BATCH_MAX + 20 },
      (_, i) => id(i + 1),
    );
    const result = await service.approveBatch(USER, [id(1), id(1), ...many]);
    expect(result.results).toHaveLength(AI_REVIEW_APPROVE_BATCH_MAX);
    expect(actions.confirm).toHaveBeenCalledTimes(AI_REVIEW_APPROVE_BATCH_MAX);
    expect(new Set(result.results.map((r) => r.id)).size).toBe(
      AI_REVIEW_APPROVE_BATCH_MAX,
    );
  });

  it("builds every card for the JWT's user: another user's id is the card path's 'not found'", async () => {
    const { service, work } = setup();
    await service.approveBatch(USER, [id(1)]);
    expect(work.buildApprovalCard).toHaveBeenCalledWith(USER, id(1));
  });
});

describe("AiReviewApprovalController", () => {
  const proto = AiReviewApprovalController.prototype as unknown as Record<
    string,
    (...args: never[]) => unknown
  >;

  it("approves for the JWT user, whatever the body claims", async () => {
    const approval = {
      approveBatch: jest.fn().mockResolvedValue({ results: [] }),
    };
    const controller = new AiReviewApprovalController(approval as never);
    await controller.approveBatch({ user: { id: USER } }, {
      ids: [id(1)],
      userId: "someone-else",
    } as never);
    expect(approval.approveBatch).toHaveBeenCalledWith(USER, [id(1)]);
  });

  it("is under the JWT guard, owner-only, and throttled", () => {
    expect(
      Reflect.getMetadata(GUARDS_METADATA, AiReviewApprovalController),
    ).toHaveLength(1);
    expect(
      Reflect.getMetadata(ALLOW_DELEGATE_KEY, AiReviewApprovalController),
    ).toBe(false);
    expect(
      Reflect.getMetadata("THROTTLER:LIMITdefault", proto.approveBatch),
    ).toBe(10);
  });

  describe("the body", () => {
    const check = (body: object) =>
      validate(plainToInstance(ApproveAiReviewBatchDto, body), {
        whitelist: true,
        forbidNonWhitelisted: true,
      });

    it.each([
      { ids: [id(1)] },
      { ids: Array.from({ length: 100 }, (_, i) => id(i + 1)) },
    ])("accepts %#", async (body) => {
      expect(await check(body)).toHaveLength(0);
    });

    it.each([
      {},
      { ids: [] },
      { ids: ["not-a-uuid"] },
      { ids: [5] },
      { ids: "x" },
      { ids: Array.from({ length: 101 }, (_, i) => id(i + 1)) },
      { ids: [id(1)], userId: "x" },
    ])("refuses %#", async (body) => {
      expect((await check(body)).length).toBeGreaterThan(0);
    });
  });
});
