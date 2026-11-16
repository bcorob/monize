import { RuleEffects } from "./rule-effects";
import { CandidateUnit } from "./rule-run-candidates";
import { buildRunSnapshots } from "./rule-run-snapshot";
import { Transaction } from "../transactions/entities/transaction.entity";

const leg = (id: string, over: Partial<Transaction> = {}): Transaction =>
  ({
    id,
    categoryId: null,
    payeeId: null,
    payeeName: "raw",
    description: "old",
    ...over,
  }) as Transaction;

const unit = (...legs: Transaction[]): CandidateUnit => ({
  primary: legs[0],
  legs,
  isTransfer: legs.length > 1,
  fromAccountId: null,
  toAccountId: null,
  crossOwnerTransferLeg: false,
});

const effects = (changes: Partial<RuleEffects["changes"]>): RuleEffects => ({
  changes: { addTagIds: [], removeTagIds: [], ...changes },
  trace: [],
  aiReviewRequests: [],
});

describe("buildRunSnapshots", () => {
  it("records the description before and after, only when a rule changed it", () => {
    const { before, after } = buildRunSnapshots(
      [
        { unit: unit(leg("a")), effects: effects({ description: "new" }) },
        { unit: unit(leg("b")), effects: effects({ categoryId: "c" }) },
      ],
      new Map(),
      {},
    );
    expect(before).toEqual([
      { id: "a", description: "old" },
      { id: "b", categoryId: null },
    ]);
    expect(after).toEqual([
      { id: "a", description: "new" },
      { id: "b", categoryId: "c" },
    ]);
  });

  it("takes a payee's name from the plan when set_payee_from_text chose it, else from the labels", () => {
    const { after } = buildRunSnapshots(
      [
        {
          unit: unit(leg("a")),
          effects: effects({ payeeId: "p1", payeeName: "From text" }),
        },
        { unit: unit(leg("b")), effects: effects({ payeeId: "p2" }) },
      ],
      new Map(),
      { p1: "Label one", p2: "Label two" },
    );
    expect(after).toEqual([
      { id: "a", payeeId: "p1", payeeName: "From text" },
      { id: "b", payeeId: "p2", payeeName: "Label two" },
    ]);
  });

  it("writes one entry per leg of a same-owner transfer", () => {
    const { before, after } = buildRunSnapshots(
      [
        {
          unit: unit(leg("out"), leg("in")),
          effects: effects({ description: "new" }),
        },
      ],
      new Map(),
      {},
    );
    expect(before.map((r) => r.id)).toEqual(["out", "in"]);
    expect(after.map((r) => r.description)).toEqual(["new", "new"]);
  });

  describe("a structural row", () => {
    const plain = (id: string) =>
      leg(id, {
        categoryId: "c-old",
        isTransfer: false,
        isSplit: false,
        linkedTransactionId: null,
      });
    const transfer = {
      kind: "transfer" as const,
      accountId: "loan",
      clearCategory: true,
      amount: 10,
    };
    const split = {
      kind: "split" as const,
      parts: [
        {
          amount: -10,
          categoryId: null,
          transferAccountId: "loan",
          payeeId: null,
          memo: null,
        },
        {
          amount: -5,
          categoryId: "c",
          transferAccountId: null,
          payeeId: null,
          memo: null,
        },
      ],
    };

    it("records the structure on both sides with the written counterpart ids", () => {
      const { before, after } = buildRunSnapshots(
        [
          {
            unit: unit(plain("a")),
            effects: effects({
              categoryId: null,
              structure: { ...transfer, counterpartIds: ["cp"] },
            }),
          },
        ],
        new Map(),
        {},
      );
      const structure = { kind: "transfer", counterpartIds: ["cp"] };
      expect(before).toEqual([
        {
          id: "a",
          categoryId: "c-old",
          isTransfer: false,
          isSplit: false,
          linkedTransactionId: null,
          structure,
        },
      ]);
      expect(after).toEqual([
        {
          id: "a",
          categoryId: null,
          isTransfer: true,
          isSplit: false,
          linkedTransactionId: "cp",
          structure,
        },
      ]);
    });

    it("keeps the category of a conversion that does not clear it", () => {
      const { before, after } = buildRunSnapshots(
        [
          {
            unit: unit(plain("a")),
            effects: effects({
              structure: {
                ...transfer,
                clearCategory: false,
                counterpartIds: ["cp"],
              },
            }),
          },
        ],
        new Map(),
        {},
      );
      expect(before[0].categoryId).toBe("c-old");
      expect(after[0].categoryId).toBe("c-old");
    });

    it("marks a split as split with no link, and clears its category", () => {
      const { after } = buildRunSnapshots(
        [
          {
            unit: unit(plain("a")),
            effects: effects({
              structure: { ...split, counterpartIds: ["cp"] },
            }),
          },
        ],
        new Map(),
        {},
      );
      expect(after[0]).toMatchObject({
        categoryId: null,
        isSplit: true,
        isTransfer: false,
        linkedTransactionId: null,
        structure: { kind: "split", counterpartIds: ["cp"] },
      });
    });

    it("measures an unwritten plan with one placeholder id per leg it will create", () => {
      const { before } = buildRunSnapshots(
        [
          { unit: unit(plain("a")), effects: effects({ structure: transfer }) },
          { unit: unit(plain("b")), effects: effects({ structure: split }) },
        ],
        new Map(),
        {},
      );
      expect(
        (before[0].structure as { counterpartIds: string[] }).counterpartIds,
      ).toHaveLength(1);
      expect(
        (before[1].structure as { counterpartIds: string[] }).counterpartIds,
      ).toHaveLength(1);
      expect(
        (before[0].structure as { counterpartIds: string[] }).counterpartIds[0],
      ).toHaveLength(36);
      // A split also records its lines (one per part), so the undo can tell
      // the lines the run wrote from lines added since.
      expect(
        (before[1].structure as { lineIds: string[] }).lineIds,
      ).toHaveLength(2);
      expect(
        (before[0].structure as { lineIds?: string[] }).lineIds,
      ).toBeUndefined();
    });
  });
});

describe("buildRunSnapshots: a settled row", () => {
  const plain = (id: string) =>
    leg(id, {
      categoryId: "c-old",
      isTransfer: false,
      isSplit: false,
      linkedTransactionId: null,
    });
  const split = {
    kind: "split" as const,
    parts: [
      {
        amount: -833.33,
        categoryId: null,
        transferAccountId: "loan",
        payeeId: null,
        memo: "Principal",
      },
      {
        amount: -500,
        categoryId: "interest",
        transferAccountId: null,
        payeeId: null,
        memo: "Interest",
      },
    ],
  };
  const settlement = (advancesCursor: boolean) =>
    ({
      loanAccountId: "loan",
      scheduledTransactionId: "st-1",
      dueDate: "2024-01-01",
      advancesCursor,
    }) as unknown as NonNullable<RuleEffects["changes"]["loanSettlement"]>;
  const cursor = {
    before: {
      nextDueDate: "2024-01-01",
      occurrencesRemaining: 10,
      isActive: true,
      lastPostedDate: null,
    },
    after: {
      nextDueDate: "2024-02-01",
      occurrencesRemaining: 9,
      isActive: true,
      lastPostedDate: "2024-01-03",
    },
    prunedOverrides: [],
  };

  it("records the written claim, the schedule, the slot and the cursor advance on both sides", () => {
    const { before, after } = buildRunSnapshots(
      [
        {
          unit: unit(plain("a")),
          effects: effects({
            structure: {
              ...split,
              counterpartIds: ["cp"],
              lineIds: ["l1", "l2"],
            },
            loanSettlement: settlement(true),
            settlementClaim: {
              claimId: "claim-1",
              scheduledTransactionId: "st-1",
              dueDate: "2024-01-01",
              cursorAdvanced: true,
              cursor,
            },
          }),
        },
      ],
      new Map(),
      {},
    );
    const structure = {
      kind: "split",
      counterpartIds: ["cp"],
      lineIds: ["l1", "l2"],
      claimId: "claim-1",
      scheduledTransactionId: "st-1",
      dueDate: "2024-01-01",
      cursorAdvanced: true,
      cursor,
    };
    expect(before[0]).toEqual({
      id: "a",
      categoryId: "c-old",
      isTransfer: false,
      isSplit: false,
      linkedTransactionId: null,
      structure,
    });
    expect(after[0]).toMatchObject({ isSplit: true, structure });
  });

  it("omits the cursor when the claim did not advance it", () => {
    const { before } = buildRunSnapshots(
      [
        {
          unit: unit(plain("a")),
          effects: effects({
            structure: {
              ...split,
              counterpartIds: ["cp"],
              lineIds: ["l1", "l2"],
            },
            loanSettlement: settlement(false),
            settlementClaim: {
              claimId: "claim-1",
              scheduledTransactionId: "st-1",
              dueDate: "2024-01-01",
              cursorAdvanced: false,
            },
          }),
        },
      ],
      new Map(),
      {},
    );
    expect(before[0].structure).toMatchObject({ cursorAdvanced: false });
    expect(before[0].structure).not.toHaveProperty("cursor");
  });

  it("measures an unwritten settlement with placeholders of the written shape, a cursor record only when the slot is the cursor", () => {
    const { before } = buildRunSnapshots(
      [
        {
          unit: unit(plain("a")),
          effects: effects({
            structure: split,
            loanSettlement: settlement(true),
          }),
        },
        {
          unit: unit(plain("b")),
          effects: effects({
            structure: split,
            loanSettlement: settlement(false),
          }),
        },
      ],
      new Map(),
      {},
    );
    const cursorRow = before[0].structure as Record<string, unknown>;
    expect(cursorRow.claimId).toHaveLength(36);
    expect(cursorRow).toMatchObject({
      scheduledTransactionId: "st-1",
      dueDate: "2024-01-01",
      cursorAdvanced: true,
      cursor: {
        before: expect.objectContaining({ nextDueDate: expect.any(String) }),
        after: expect.objectContaining({ nextDueDate: expect.any(String) }),
        prunedOverrides: [],
      },
    });
    expect(before[1].structure).toMatchObject({ cursorAdvanced: false });
    expect(before[1].structure).not.toHaveProperty("cursor");
  });
});
