import { NotFoundException } from "@nestjs/common";
import { createScopedDbMocks } from "../../test-helpers/scoped-db-testing";
import { EmailReceipt } from "../entities/email-receipt.entity";
import { EmailReceiptParser } from "../entities/email-receipt-parser.entity";
import {
  EMAIL_RECEIPT_PROFILE_BATCH_PAGE,
  EmailReceiptProfileBatchService,
} from "./email-receipt-profile-batch.service";

jest.mock("../../common/db/scoped-db", () =>
  jest
    .requireActual("../../test-helpers/scoped-db-testing")
    .scopedDbMockModule(),
);

const USER = "user-1";
const PROFILE = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";

const parser = (over: Partial<EmailReceiptParser> = {}) =>
  ({
    id: PROFILE,
    userId: USER,
    status: "approved",
    fromDomains: ["shop.example.com"],
    subjectContains: [],
    createdAt: new Date("2026-01-01T00:00:00Z"),
    definition: { version: 2, total: ["Total {amount}"] },
    ...over,
  }) as EmailReceiptParser;

/** A profile for the more specific `orders.shop.example.com`: it reads that sub-domain's mail. */
const orders = parser({
  id: OTHER,
  fromDomains: ["orders.shop.example.com"],
  createdAt: new Date("2026-02-01T00:00:00Z"),
});

interface Row {
  id: string;
  from_domain: string;
  subject: string;
  body_text: string;
  body_html: string | null;
  status: string;
  request_status: string | null;
}

const email = (id: string, over: Partial<Row> = {}): Row => ({
  id,
  from_domain: "shop.example.com",
  subject: "Your order",
  body_text: "Order confirmed\nTotal 5.00",
  body_html: null,
  status: "review",
  request_status: "proposed",
  ...over,
});

/** The page: ours, the sub-domain profile's, an applied one, an unreadable one, an ignored one. */
const PAGE: Row[] = [
  email("a"),
  email("b", { from_domain: "orders.shop.example.com" }),
  email("c", { request_status: "applied" }),
  email("d", { status: "skipped", body_text: "", request_status: null }),
  email("e", { status: "ignored", request_status: null }),
];

function setup(
  options: {
    rows?: Row[];
    profile?: EmailReceiptParser | null;
    approved?: EmailReceiptParser[];
  } = {},
) {
  const rows = options.rows ?? PAGE;
  const profile = options.profile === undefined ? parser() : options.profile;
  const parserRepo = {
    findOne: jest.fn().mockResolvedValue(profile),
    find: jest.fn().mockResolvedValue(options.approved ?? [parser(), orders]),
  };
  const receiptRepo = {
    findOne: jest.fn(({ where }: { where: { id: string } }) => {
      const row = rows.find((r) => r.id === where.id);
      return Promise.resolve(
        row
          ? Object.assign(new EmailReceipt(), {
              id: row.id,
              userId: USER,
              status: row.status,
              transactionId: null,
              aiReviewRequestId: row.request_status ? `rq-${row.id}` : null,
            })
          : null,
      );
    }),
    update: jest.fn().mockResolvedValue({ affected: 1 }),
    delete: jest.fn().mockResolvedValue({ affected: 1 }),
  };
  const { manager, dataSource } = createScopedDbMocks([
    [EmailReceipt, receiptRepo],
    [EmailReceiptParser, parserRepo],
  ]);
  manager.query.mockImplementation((sql: string, params: unknown[]) => {
    if (sql.includes("FROM email_receipts r")) return Promise.resolve(rows);
    if (sql.includes("FROM ai_review_requests WHERE id")) {
      const row = rows.find((r) => `rq-${r.id}` === params[0]);
      return Promise.resolve(
        row?.request_status
          ? [{ status: row.request_status, kind: "receipt" }]
          : [],
      );
    }
    return Promise.resolve([]);
  });
  const service = new EmailReceiptProfileBatchService(dataSource as never);
  return { service, manager, receiptRepo, parserRepo };
}

const idsOf = (mock: jest.Mock): string[] =>
  mock.mock.calls.map((call) => (call[0] as { id: string }).id);

describe("EmailReceiptProfileBatchService", () => {
  it("counts the emails the pipeline would give the profile, and what each action would keep", async () => {
    const { service, receiptRepo } = setup();
    await expect(service.run(USER, PROFILE, "count")).resolves.toEqual({
      // "b" is the sub-domain profile's: never this profile's.
      matched: 4,
      applied: 1,
      unreadable: 1,
      ignored: 1,
      done: 0,
      next: null,
    });
    expect(receiptRepo.update).not.toHaveBeenCalled();
    expect(receiptRepo.delete).not.toHaveBeenCalled();
  });

  it("ignores only what the single action would: not applied, unreadable or already ignored", async () => {
    const { service, receiptRepo, manager } = setup();
    const result = await service.run(USER, PROFILE, "ignore");
    expect(result.done).toBe(1);
    expect(idsOf(receiptRepo.update)).toEqual(["a"]);
    expect(receiptRepo.update).toHaveBeenCalledWith(
      { id: "a", userId: USER },
      {
        status: "ignored",
        statusReason: null,
        aiReviewRequestId: null,
        linkKey: null,
      },
    );
    // Its open request is closed with it.
    expect(
      manager.query.mock.calls.some((c) =>
        String(c[0]).includes("SET status = 'rejected'"),
      ),
    ).toBe(true);
  });

  it("deletes every matched email but an applied one, each under its own lock", async () => {
    const { service, receiptRepo } = setup();
    const result = await service.run(USER, PROFILE, "delete");
    expect(result.done).toBe(3);
    expect(idsOf(receiptRepo.delete)).toEqual(["a", "d", "e"]);
    for (const id of ["a", "c", "d", "e"]) {
      expect(receiptRepo.findOne).toHaveBeenCalledWith({
        where: { id, userId: USER },
        lock: { mode: "pessimistic_write" },
      });
    }
  });

  it("asks requireLine as the pipeline does: an email without the line is not the profile's", async () => {
    const strict = parser({
      definition: {
        version: 2,
        total: ["Total {amount}"],
        requireLine: ["Order confirmed"],
      },
    });
    const { service } = setup({
      profile: strict,
      approved: [strict],
      rows: [email("a"), email("x", { body_text: "Newsletter\nTotal 1.00" })],
    });
    const result = await service.run(USER, PROFILE, "count");
    expect(result.matched).toBe(1);
  });

  it("asks about a draft profile as if it were approved", async () => {
    const draft = parser({ status: "draft" });
    const { service } = setup({
      profile: draft,
      approved: [],
      rows: [email("a")],
    });
    await expect(service.run(USER, PROFILE, "count")).resolves.toMatchObject({
      matched: 1,
    });
  });

  it("answers the cursor of the next page when the page is full, and reads after the one it is given", async () => {
    const rows = Array.from(
      { length: EMAIL_RECEIPT_PROFILE_BATCH_PAGE },
      (_, i) => email(`id-${String(i).padStart(3, "0")}`),
    );
    const { service, manager } = setup({ rows });
    const result = await service.run(USER, PROFILE, "count", "id-start");
    expect(result.next).toBe(rows[rows.length - 1].id);
    const scan = manager.query.mock.calls.find((c) =>
      String(c[0]).includes("FROM email_receipts r"),
    );
    expect(scan?.[1]).toEqual([
      USER,
      ["shop.example.com"],
      "id-start",
      EMAIL_RECEIPT_PROFILE_BATCH_PAGE,
    ]);
  });

  it("is a 404 for a profile the user does not have, and touches nothing", async () => {
    const { service, receiptRepo } = setup({ profile: null });
    await expect(service.run(USER, PROFILE, "delete")).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(receiptRepo.delete).not.toHaveBeenCalled();
  });
});
