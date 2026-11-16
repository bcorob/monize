import "reflect-metadata";
import {
  emailReceiptParsersSchema,
  validateToolInput,
} from "./tool-input-schemas";

const R1 = "e0000000-0000-4000-8000-000000000001";
const REQ = "e0000000-0000-4000-8000-000000000009";
const DEFINITION = { version: 2, total: ["Order total: {amount}"] };

describe("email_receipt_parsers schema", () => {
  it.each([
    [{ operation: "categories" }],
    [{ operation: "get" }],
    [{ operation: "get", parserId: REQ }],
    [{ operation: "test", definition: DEFINITION, receiptIds: [R1] }],
    [
      {
        operation: "test",
        definition: DEFINITION,
        receiptIds: [R1],
        payeeName: "Shop",
      },
    ],
    [
      {
        operation: "save_draft",
        name: "Shop",
        fromDomains: ["shop.example.com"],
        definition: DEFINITION,
      },
    ],
    [
      {
        operation: "save_draft",
        requestId: REQ,
        name: "Shop",
        fromDomains: ["shop.example.com"],
        subjectContains: ["order"],
        payeeName: "Shop",
        definition: DEFINITION,
      },
    ],
    [
      {
        operation: "test",
        definition: DEFINITION,
        samples: [{ receiptId: R1, transactionId: REQ }, { receiptId: R1 }],
      },
    ],
    [
      {
        operation: "save_draft",
        parserId: REQ,
        expectedRevision: 3,
        name: "Shop",
        fromDomains: ["shop.example.com"],
        definition: DEFINITION,
      },
    ],
  ])("accepts %j", (input) => {
    expect(emailReceiptParsersSchema.safeParse(input).success).toBe(true);
  });

  it.each([
    ["an unknown operation", { operation: "approve" }],
    ["get with a non-uuid parserId", { operation: "get", parserId: "nope" }],
    ["test with no definition", { operation: "test", receiptIds: [R1] }],
    ["test with no emails", { operation: "test", definition: DEFINITION }],
    [
      "test with no email ids",
      { operation: "test", definition: DEFINITION, receiptIds: [] },
    ],
    [
      "test with 26 emails",
      {
        operation: "test",
        definition: DEFINITION,
        receiptIds: Array.from({ length: 26 }, () => R1),
      },
    ],
    [
      "test with a non-uuid email",
      { operation: "test", definition: DEFINITION, receiptIds: ["nope"] },
    ],
    [
      "test with 26 samples",
      {
        operation: "test",
        definition: DEFINITION,
        samples: Array.from({ length: 26 }, () => ({ receiptId: R1 })),
      },
    ],
    [
      "test with a sample that has a bad transaction id",
      {
        operation: "test",
        definition: DEFINITION,
        samples: [{ receiptId: R1, transactionId: "nope" }],
      },
    ],
    [
      "save_draft with a parserId and no expectedRevision",
      {
        operation: "save_draft",
        parserId: REQ,
        name: "Shop",
        fromDomains: ["shop.example.com"],
        definition: DEFINITION,
      },
    ],
    [
      "an expectedRevision of zero",
      {
        operation: "save_draft",
        parserId: REQ,
        expectedRevision: 0,
        name: "Shop",
        fromDomains: ["shop.example.com"],
        definition: DEFINITION,
      },
    ],
    [
      "a non-object definition",
      { operation: "test", definition: "x", receiptIds: [R1] },
    ],
    [
      "an array as the definition",
      { operation: "test", definition: [], receiptIds: [R1] },
    ],
    [
      "save_draft with no name",
      {
        operation: "save_draft",
        fromDomains: ["a.example.com"],
        definition: DEFINITION,
      },
    ],
    [
      "save_draft with a blank name",
      {
        operation: "save_draft",
        name: " ",
        fromDomains: ["a.example.com"],
        definition: DEFINITION,
      },
    ],
    [
      "save_draft with no domains",
      { operation: "save_draft", name: "x", definition: DEFINITION },
    ],
    [
      "save_draft with eleven domains",
      {
        operation: "save_draft",
        name: "x",
        definition: DEFINITION,
        fromDomains: Array.from({ length: 11 }, (_, i) => `d${i}.example.com`),
      },
    ],
    [
      "save_draft with no definition",
      { operation: "save_draft", name: "x", fromDomains: ["a.example.com"] },
    ],
    [
      "save_draft with a non-uuid request",
      {
        operation: "save_draft",
        requestId: "x",
        name: "x",
        fromDomains: ["a.example.com"],
        definition: DEFINITION,
      },
    ],
    [
      "a name over 100 characters",
      {
        operation: "save_draft",
        name: "x".repeat(101),
        fromDomains: ["a.example.com"],
        definition: DEFINITION,
      },
    ],
  ])("refuses %s", (_name, input) => {
    expect(emailReceiptParsersSchema.safeParse(input).success).toBe(false);
  });

  it("strips a field it does not know: a user id in the arguments is never read", () => {
    const parsed = emailReceiptParsersSchema.parse({
      operation: "categories",
      userId: "someone-else",
    });

    expect(parsed).not.toHaveProperty("userId");
  });

  it("is registered for validateToolInput", () => {
    expect(
      validateToolInput("email_receipt_parsers", { operation: "categories" }),
    ).toEqual({ success: true, data: { operation: "categories" } });
    expect(
      validateToolInput("email_receipt_parsers", { operation: "test" }).success,
    ).toBe(false);
  });
});
