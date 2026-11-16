import { RuleTraceChanges } from "./rule-effects";
import { canonicalChanges, planFingerprint } from "./rule-run-fingerprint";

const change = (id: string, changes: RuleTraceChanges) => ({
  transactionId: id,
  changes,
});

describe("planFingerprint", () => {
  const a = change("a", { categoryId: { before: null, after: "c1" } });
  const b = change("b", {
    tagIds: { before: [], after: ["g1", "g2"] },
  });

  it("is a SHA-256 hex digest", () => {
    expect(planFingerprint(1, [a])).toMatch(/^[0-9a-f]{64}$/);
  });

  it("does not depend on the order the rows were planned in", () => {
    expect(planFingerprint(1, [a, b])).toBe(planFingerprint(1, [b, a]));
  });

  it("does not depend on the order of a tag set", () => {
    const reordered = change("b", {
      tagIds: { before: [], after: ["g2", "g1"] },
    });
    expect(planFingerprint(1, [a, b])).toBe(planFingerprint(1, [a, reordered]));
  });

  it("changes with the rule revision", () => {
    expect(planFingerprint(1, [a, b])).not.toBe(planFingerprint(2, [a, b]));
  });

  it("changes with a row, a change or a missing row", () => {
    const base = planFingerprint(1, [a, b]);
    expect(planFingerprint(1, [a])).not.toBe(base);
    expect(
      planFingerprint(1, [
        change("a", { categoryId: { before: null, after: "c2" } }),
        b,
      ]),
    ).not.toBe(base);
    expect(
      planFingerprint(1, [
        change("a", { categoryId: { before: "c0", after: "c1" } }),
        b,
      ]),
    ).not.toBe(base);
    expect(planFingerprint(1, [change("z", a.changes), b])).not.toBe(base);
  });

  it("an empty plan still has a fingerprint that depends on the revision", () => {
    expect(planFingerprint(1, [])).not.toBe(planFingerprint(2, []));
  });

  describe("the rows queued for an AI review", () => {
    it("hash as before when a plan queues none", () => {
      expect(planFingerprint(1, [a, b], [])).toBe(planFingerprint(1, [a, b]));
    });

    it("change the hash of a plan with no field changes, whatever their order", () => {
      const none = planFingerprint(1, []);
      const one = planFingerprint(1, [], ["t1"]);
      const two = planFingerprint(1, [], ["t1", "t2"]);
      expect(new Set([none, one, two]).size).toBe(3);
      expect(planFingerprint(1, [], ["t2", "t1"])).toBe(two);
      expect(planFingerprint(1, [], ["t2"])).not.toBe(one);
    });
  });
});

describe("canonicalChanges", () => {
  it("fixes the key order and nulls the absent fields", () => {
    expect(
      JSON.stringify(
        canonicalChanges({
          tagIds: { before: ["b", "a"], after: ["c"] },
        }),
      ),
    ).toBe(
      '{"categoryId":null,"payeeId":null,"tagIds":{"before":["a","b"],"after":["c"]}}',
    );
  });

  describe("the text actions' fields", () => {
    const base = change("a", { categoryId: { before: null, after: "c1" } });

    it("hash as before when a plan has none of them", () => {
      expect(Object.keys(canonicalChanges(base.changes))).toEqual([
        "categoryId",
        "payeeId",
        "tagIds",
      ]);
    });

    it("change with the payee name, the creation note and the description", () => {
      const plain = planFingerprint(1, [
        change("a", { payeeId: { before: null, after: "p1" } }),
      ]);
      const named = planFingerprint(1, [
        change("a", {
          payeeId: { before: null, after: "p1" },
          payeeName: { before: null, after: "Acme" },
        }),
      ]);
      const created = planFingerprint(1, [
        change("a", {
          payeeId: { before: null, after: "p1" },
          payeeName: { before: null, after: "Acme" },
          payeeCreated: true,
        }),
      ]);
      const described = planFingerprint(1, [
        change("a", { description: { before: "x", after: "y" } }),
      ]);
      const describedOther = planFingerprint(1, [
        change("a", { description: { before: "x", after: "z" } }),
      ]);
      expect(
        new Set([plain, named, created, described, describedOther]).size,
      ).toBe(5);
    });
  });
});

describe("canonicalChanges: a settlement", () => {
  const settlement = (debtBefore: string, extra: object = {}) => ({
    loanAccountId: "loan",
    scheduledTransactionId: "st",
    dueDate: "2024-02-01",
    installmentNumber: 2,
    pricing: {
      dueDate: "2024-02-01",
      installmentNumber: 2,
      method: "LINEAR" as const,
      prepaymentMode: "SHORTEN_TERM" as const,
      currencyCode: "EUR",
      debtLedger: "300000.0000",
      foldedPrincipal: "1033.3300",
      debtBefore,
      annualRate: "2",
      periodicRate: 0.0016666666666666668,
      priced: {
        principal: "833.3333",
        interest: "498.2778",
        extra: "0.0000",
        total: "1331.6111",
      },
      booked: {
        principal: "833.33",
        interest: "498.28",
        extra: "0.00",
        total: "1331.61",
      },
      paid: "1331.61",
      difference: "0.00",
      outcome: "exact" as const,
      lines: { principal: "833.33", interest: "498.28", extra: "0.00" },
    },
    ...extra,
  });
  const structure = {
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
        amount: -498.28,
        categoryId: "interest",
        transferAccountId: null,
        payeeId: null,
        memo: "Interest",
      },
    ],
  };
  const planned = (debtBefore: string, extra: object = {}) =>
    change("a", {
      structure: { before: null, after: structure },
      loanSettlement: { before: null, after: settlement(debtBefore, extra) },
    });

  it("two plans differing only in debtBefore hash differently (INV-RULE-005)", () => {
    // The fold moved between the preview and the commit: same lines, same
    // slot, another debt; the commit must refuse as a changed preview.
    expect(planFingerprint(1, [planned("298966.6700")])).not.toBe(
      planFingerprint(1, [planned("300000.0000")]),
    );
  });

  it("a plan without a settlement hashes as before: no loanSettlement key", () => {
    expect(
      Object.keys(
        canonicalChanges({ structure: { before: null, after: structure } }),
      ),
    ).toEqual(["categoryId", "payeeId", "tagIds", "structure"]);
  });

  it("reads only the planned fields: the claim a stored trace adds does not change the hash", () => {
    const written = planned("298966.6700", {
      claimId: "claim-1",
      cursorAdvanced: true,
      cursor: {
        before: { nextDueDate: "2024-02-01" },
        after: { nextDueDate: "2024-03-01" },
      },
    });
    expect(planFingerprint(1, [written])).toBe(
      planFingerprint(1, [planned("298966.6700")]),
    );
    const canonical = canonicalChanges(written.changes);
    expect(canonical.loanSettlement?.after).not.toHaveProperty("claimId");
    expect(canonical.loanSettlement?.after).toMatchObject({
      dueDate: "2024-02-01",
      pricing: { debtBefore: "298966.6700" },
    });
  });
});
