import "reflect-metadata";
import {
  aiReviewRequestsSchema,
  validateToolInput,
} from "./tool-input-schemas";

const REQ = "e0000000-0000-4000-8000-000000000009";
const lines = [
  { categoryName: "Books", amount: -30 },
  { categoryName: "Toys", amount: -20, memo: "gift" },
];

describe("ai_review_requests schema", () => {
  it.each([
    [{ operation: "list" }],
    [{ operation: "list", limit: "10" }],
    [{ operation: "claim" }],
    [{ operation: "submit", requestId: REQ, splits: lines }],
    [{ operation: "submit", requestId: REQ, categoryName: "Books" }],
    [
      {
        operation: "submit",
        requestId: REQ,
        payeeName: "Allegro",
        description: "x",
      },
    ],
    [{ operation: "reject", requestId: REQ, reason: "no order id" }],
    [
      {
        operation: "reject",
        requestId: REQ,
        reason: "x",
        cannotBeDone: "true",
      },
    ],
  ])("accepts %j", (input) => {
    expect(aiReviewRequestsSchema.safeParse(input).success).toBe(true);
  });

  it("reads a numeric-string amount and limit as numbers, and refuses an empty amount", () => {
    const parsed = aiReviewRequestsSchema.parse({
      operation: "submit",
      requestId: REQ,
      splits: [lines[0], { categoryName: "Toys", amount: "-20" }],
    });
    expect(parsed.splits?.[1].amount).toBe(-20);
    expect(
      aiReviewRequestsSchema.safeParse({
        operation: "submit",
        requestId: REQ,
        splits: [lines[0], { categoryName: "Toys", amount: "" }],
      }).success,
    ).toBe(false);
    expect(
      aiReviewRequestsSchema.parse({ operation: "list", limit: "7" }).limit,
    ).toBe(7);
  });

  it.each([
    [{ operation: "bogus" }],
    [{ operation: "list", limit: 0 }],
    [{ operation: "list", limit: 51 }],
    [{ operation: "submit", splits: lines }],
    [{ operation: "submit", requestId: "nope", splits: lines }],
    [{ operation: "submit", requestId: REQ }],
    [{ operation: "submit", requestId: REQ, splits: [lines[0]] }],
    [
      {
        operation: "submit",
        requestId: REQ,
        splits: lines,
        categoryName: "Books",
      },
    ],
    [
      {
        operation: "submit",
        requestId: REQ,
        splits: [{ categoryName: "", amount: 1 }, lines[0]],
      },
    ],
    [{ operation: "reject", reason: "x" }],
    [{ operation: "reject", requestId: REQ }],
  ])("rejects %j", (input) => {
    expect(aiReviewRequestsSchema.safeParse(input).success).toBe(false);
  });

  it("carries no amount, date or account for a proposal to change", () => {
    const parsed = aiReviewRequestsSchema.parse({
      operation: "submit",
      requestId: REQ,
      description: "x",
      amount: 999,
      date: "2026-01-01",
      accountName: "Other",
    });
    expect(parsed).not.toHaveProperty("amount");
    expect(parsed).not.toHaveProperty("date");
    expect(parsed).not.toHaveProperty("accountName");
  });

  it("is registered for validateToolInput", () => {
    expect(
      validateToolInput("ai_review_requests", { operation: "claim" }),
    ).toEqual({
      success: true,
      data: { operation: "claim" },
    });
    const bad = validateToolInput("ai_review_requests", {
      operation: "submit",
    });
    expect(bad.success).toBe(false);
  });
});
