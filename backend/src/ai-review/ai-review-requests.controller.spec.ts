import "reflect-metadata";
import { GUARDS_METADATA } from "@nestjs/common/constants";
import { ROUTE_ARGS_METADATA } from "@nestjs/common/constants";
import { ParseUUIDPipe } from "@nestjs/common";
import { validate } from "class-validator";
import { plainToInstance } from "class-transformer";
import { AiReviewRequestsController } from "./ai-review-requests.controller";
import { ListAiReviewRequestsDto } from "./dto/list-ai-review-requests.dto";
import { ALLOW_DELEGATE_KEY } from "../delegation/decorators/delegate-access.decorator";

describe("AiReviewRequestsController", () => {
  const req = { user: { id: "user-1" } };
  const work = { listInbox: jest.fn(), dismiss: jest.fn() };
  const controller = new AiReviewRequestsController(work as never);
  const proto = AiReviewRequestsController.prototype;

  beforeEach(() => jest.clearAllMocks());

  it("lists the JWT user's requests with the query's filters", async () => {
    work.listInbox.mockResolvedValue([{ id: "r1" }]);

    const result = await controller.list(req, {
      status: "proposed",
      limit: 10,
    });

    expect(work.listInbox).toHaveBeenCalledWith("user-1", {
      status: "proposed",
      limit: 10,
    });
    expect(result).toEqual([{ id: "r1" }]);
  });

  it("dismisses for the JWT user", async () => {
    work.dismiss.mockResolvedValue({ id: "r1", status: "rejected" });
    await controller.dismiss(req, "r1");
    expect(work.dismiss).toHaveBeenCalledWith("user-1", "r1");
  });

  it("parses the :id param as a UUID", () => {
    const meta = Reflect.getMetadata(
      ROUTE_ARGS_METADATA,
      AiReviewRequestsController,
      "dismiss",
    ) as Record<string, { data?: string; pipes: unknown[] }>;
    const param = Object.values(meta).find((m) => m.data === "id");
    expect(param?.pipes).toContain(ParseUUIDPipe);
  });

  it("is under the JWT guard and refuses a delegate session on every route", () => {
    expect(
      Reflect.getMetadata(GUARDS_METADATA, AiReviewRequestsController),
    ).toHaveLength(1);
    expect(
      Reflect.getMetadata(ALLOW_DELEGATE_KEY, AiReviewRequestsController),
    ).toBe(false);
    for (const name of Object.getOwnPropertyNames(proto)) {
      if (name === "constructor") continue;
      expect(
        Reflect.getMetadata(ALLOW_DELEGATE_KEY, (proto as never)[name]),
      ).not.toBe(true);
    }
  });

  describe("ListAiReviewRequestsDto", () => {
    const check = async (plain: Record<string, unknown>) =>
      validate(plainToInstance(ListAiReviewRequestsDto, plain), {
        whitelist: true,
        forbidNonWhitelisted: true,
      });

    it("accepts a known status and a bounded limit given as a query string", async () => {
      expect(await check({ status: "expired", limit: "200" })).toEqual([]);
      expect(await check({})).toEqual([]);
    });

    it.each([
      [{ status: "bogus" }],
      [{ limit: "0" }],
      [{ limit: "201" }],
      [{ limit: "1.5" }],
      [{ userId: "someone-else" }],
    ])("refuses %j", async (plain) => {
      expect((await check(plain)).length).toBeGreaterThan(0);
    });
  });
});
