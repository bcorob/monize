import "reflect-metadata";
import { GUARDS_METADATA, ROUTE_ARGS_METADATA } from "@nestjs/common/constants";
import { ParseUUIDPipe } from "@nestjs/common";
import { ALLOW_DELEGATE_KEY } from "../../delegation/decorators/delegate-access.decorator";
import "reflect-metadata";
import { plainToInstance } from "class-transformer";
import { validate } from "class-validator";
import {
  DraftParserWithAiDto,
  GenerateParserWithAiDto,
  PreviewEmailReceiptParserDto,
} from "./dto/email-receipt-parser.dto";
import { EmailReceiptParsersController } from "./email-receipt-parsers.controller";

describe("EmailReceiptParsersController", () => {
  const req = { user: { id: "user-1" } };
  const parsers = {
    list: jest.fn(),
    get: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
    remove: jest.fn(),
    approve: jest.fn(),
    test: jest.fn(),
    requestAiDraft: jest.fn(),
  };
  const generator = { generate: jest.fn() };
  const previews = { preview: jest.fn() };
  const controller = new EmailReceiptParsersController(
    parsers as never,
    generator as never,
    previews as never,
  );
  const ID = "0b9c6b1e-0f3a-4a55-9d57-0c5d3d9f1a11";

  beforeEach(() => jest.clearAllMocks());

  it("acts for the JWT user on every call", async () => {
    const body = { userId: "someone-else" } as never;
    await controller.list(req);
    await controller.get(req, ID);
    await controller.create(req, body);
    await controller.update(req, ID, body);
    await controller.remove(req, ID);
    await controller.approve(req, ID, body);
    await controller.test(req, body);
    await controller.draftWithAi(req, {
      receiptIds: [ID],
      userId: "someone-else",
    } as never);
    expect(parsers.requestAiDraft).toHaveBeenCalledWith(
      "user-1",
      [ID],
      "receipt",
    );
    await controller.draftWithAi(req, { receiptIds: [ID], kind: "trade" });
    expect(parsers.requestAiDraft).toHaveBeenLastCalledWith(
      "user-1",
      [ID],
      "trade",
    );
    expect(parsers.list).toHaveBeenCalledWith("user-1");
    expect(parsers.get).toHaveBeenCalledWith("user-1", ID);
    expect(parsers.create).toHaveBeenCalledWith("user-1", body);
    expect(parsers.update).toHaveBeenCalledWith("user-1", ID, body);
    expect(parsers.remove).toHaveBeenCalledWith("user-1", ID);
    expect(parsers.approve).toHaveBeenCalledWith("user-1", ID, body);
    expect(parsers.test).toHaveBeenCalledWith("user-1", body);
  });

  it("generates and previews for the JWT user, never the body's", async () => {
    const body = { userId: "someone-else" } as never;
    await controller.generateWithAi(req, body);
    await controller.preview(req, ID, body);
    expect(generator.generate).toHaveBeenCalledWith("user-1", body);
    expect(previews.preview).toHaveBeenCalledWith("user-1", ID, body);
  });

  it("declares generate-with-ai before :id", () => {
    const names = Object.getOwnPropertyNames(
      EmailReceiptParsersController.prototype,
    );
    expect(names.indexOf("generateWithAi")).toBeLessThan(names.indexOf("get"));
    expect(
      Reflect.getMetadata(
        "path",
        EmailReceiptParsersController.prototype.generateWithAi,
      ),
    ).toBe("generate-with-ai");
  });

  it("is under the JWT guard and refuses a delegate session on every route", () => {
    expect(
      Reflect.getMetadata(GUARDS_METADATA, EmailReceiptParsersController),
    ).toHaveLength(1);
    expect(
      Reflect.getMetadata(ALLOW_DELEGATE_KEY, EmailReceiptParsersController),
    ).toBe(false);
    const proto = EmailReceiptParsersController.prototype as unknown as Record<
      string,
      (...args: never[]) => unknown
    >;
    for (const name of Object.getOwnPropertyNames(proto)) {
      if (name === "constructor") continue;
      expect(Reflect.getMetadata(ALLOW_DELEGATE_KEY, proto[name])).not.toBe(
        true,
      );
    }
  });

  it("parses every :id with ParseUUIDPipe", () => {
    const routes = ["get", "update", "remove", "approve", "preview"];
    for (const name of routes) {
      const args = Reflect.getMetadata(
        ROUTE_ARGS_METADATA,
        EmailReceiptParsersController,
        name,
      ) as Record<string, { data?: string; pipes: unknown[] }>;
      const idArg = Object.values(args).find((a) => a.data === "id");
      expect(idArg?.pipes).toContain(ParseUUIDPipe);
    }
  });

  it("throttles the provider-backed route tightly", () => {
    expect(
      Reflect.getMetadata(
        "THROTTLER:LIMITdefault",
        EmailReceiptParsersController.prototype.generateWithAi,
      ),
    ).toBe(5);
  });

  it("throttles the draft request route tightly", () => {
    expect(
      Reflect.getMetadata(
        "THROTTLER:LIMITdefault",
        EmailReceiptParsersController.prototype.draftWithAi,
      ),
    ).toBe(10);
  });

  describe("the draft-with-ai body", () => {
    const U1 = "0b9c6b1e-0f3a-4a55-9d57-0c5d3d9f1a11";
    const U2 = "0b9c6b1e-0f3a-4a55-9d57-0c5d3d9f1a12";
    const check = (body: object) =>
      validate(plainToInstance(DraftParserWithAiDto, body), {
        whitelist: true,
        forbidNonWhitelisted: true,
      });
    const ids = (n: number) =>
      Array.from(
        { length: n },
        (_, i) => `0b9c6b1e-0f3a-4a55-9d57-0c5d3d9f${1000 + i}`,
      );

    it("accepts one to 25 distinct uuids", async () => {
      expect(await check({ receiptIds: [U1] })).toHaveLength(0);
      expect(await check({ receiptIds: [U1, U2] })).toHaveLength(0);
      expect(await check({ receiptIds: ids(25) })).toHaveLength(0);
    });

    it.each([
      ["none", []],
      ["26", ids(26)],
      ["a duplicate", [U1, U1]],
      ["a non-uuid", ["not-a-uuid"]],
      ["a non-string", [42]],
    ])("refuses %s", async (_name, receiptIds) => {
      expect((await check({ receiptIds })).length).toBeGreaterThan(0);
    });

    it("refuses a missing list and an unknown field", async () => {
      expect((await check({})).length).toBeGreaterThan(0);
      expect(
        (await check({ receiptIds: [U1], userId: U2 })).length,
      ).toBeGreaterThan(0);
    });
  });
});

describe("the profile wizard bodies", () => {
  const U = (n: number) =>
    `0b9c6b1e-0f3a-4a55-9d57-${String(n).padStart(12, "0")}`;
  const pair = (n: number) => ({ receiptId: U(n), transactionId: U(n + 5) });
  const check = <T extends object>(cls: new () => T, body: object) =>
    validate(plainToInstance(cls, body), {
      whitelist: true,
      forbidNonWhitelisted: true,
    });

  describe("generate-with-ai", () => {
    const body = (over: Record<string, unknown> = {}) => ({
      domain: "Shop.Example.com ",
      samples: [pair(1)],
      ...over,
    });

    it("accepts one to five samples, a draft id and a note", async () => {
      expect(await check(GenerateParserWithAiDto, body())).toHaveLength(0);
      expect(
        await check(
          GenerateParserWithAiDto,
          body({
            samples: [1, 2, 3, 4, 5].map(pair),
            parserId: U(9),
            feedback: "x".repeat(2000),
          }),
        ),
      ).toHaveLength(0);
      expect(
        await check(GenerateParserWithAiDto, body({ parserId: "" })),
      ).toHaveLength(0);
    });

    it("normalizes the domain", () => {
      expect(plainToInstance(GenerateParserWithAiDto, body()).domain).toBe(
        "shop.example.com",
      );
    });

    it.each([
      ["no samples", { samples: [] }],
      ["six samples", { samples: [1, 2, 3, 4, 5, 6].map(pair) }],
      ["a repeated email", { samples: [pair(1), pair(1)] }],
      ["a sample with no transaction", { samples: [{ receiptId: U(1) }] }],
      ["a sample with a bad id", { samples: [{ ...pair(1), receiptId: "x" }] }],
      ["an extra sample field", { samples: [{ ...pair(1), userId: "x" }] }],
      ["a bad domain", { domain: "not a domain" }],
      ["no domain", { domain: undefined }],
      ["a bad draft id", { parserId: "nope" }],
      ["a note over 2000", { feedback: "x".repeat(2001) }],
      ["a non-string note", { feedback: 5 }],
      ["an unknown field", { userId: "someone-else" }],
    ])("refuses %s", async (_name, over) => {
      expect(
        (await check(GenerateParserWithAiDto, body(over))).length,
      ).toBeGreaterThan(0);
    });
  });

  describe("preview", () => {
    it("accepts none to five selected emails and their expected transactions", async () => {
      expect(
        await check(PreviewEmailReceiptParserDto, { selectedReceiptIds: [] }),
      ).toHaveLength(0);
      expect(
        await check(PreviewEmailReceiptParserDto, {
          selectedReceiptIds: [1, 2, 3, 4, 5].map(U),
          expected: [pair(1)],
        }),
      ).toHaveLength(0);
    });

    it.each([
      ["no selection field", {}],
      ["six selected", { selectedReceiptIds: [1, 2, 3, 4, 5, 6].map(U) }],
      ["a repeated email", { selectedReceiptIds: [U(1), U(1)] }],
      ["a bad id", { selectedReceiptIds: ["x"] }],
      [
        "six expected",
        { selectedReceiptIds: [], expected: [1, 2, 3, 4, 5, 6].map(pair) },
      ],
      [
        "a repeated expected email",
        { selectedReceiptIds: [], expected: [pair(1), pair(1)] },
      ],
      [
        "an expected pair with no transaction",
        { selectedReceiptIds: [], expected: [{ receiptId: U(1) }] },
      ],
      ["an unknown field", { selectedReceiptIds: [], userId: "x" }],
    ])("refuses %s", async (_name, body) => {
      expect(
        (await check(PreviewEmailReceiptParserDto, body)).length,
      ).toBeGreaterThan(0);
    });
  });
});
