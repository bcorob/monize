import {
  RECEIPT_LINK_OUTCOMES,
  hasJoinedPart,
  joinSettlement,
  type JoinPart,
} from "./join-settlement";
import type {
  ParsedReceipt,
  ParsedReceiptItem,
} from "../parsing/receipt-parser.types";

const CAT_GOODS = "11111111-1111-4111-8111-111111111111";
const CAT_SHIP = "22222222-2222-4222-8222-222222222222";
const CAT_DISC = "33333333-3333-4333-8333-333333333333";
const CAT_PART = "44444444-4444-4444-8444-444444444444";

/** Whole currency units to 1/10000 units, integer. */
const u = (cents: number): number => cents * 100;

const receipt = (over: Partial<ParsedReceipt>): ParsedReceipt => ({
  orderId: null,
  total: null,
  paid: null,
  payee: null,
  shipping: null,
  discount: null,
  items: [],
  shippingCategoryId: null,
  discountCategoryId: null,
  complete: true,
  reason: null,
  ...over,
});

const part = (
  amountCents: number,
  link: string | null,
  extra: Partial<ParsedReceiptItem> = {},
): ParsedReceiptItem => ({
  name: `Part ${link ?? "x"}`,
  qty: 1,
  amount: u(amountCents),
  categoryId: CAT_PART,
  ...(link === null ? {} : { link }),
  ...extra,
});

const settlementOf = (
  items: ParsedReceiptItem[],
  over: Partial<ParsedReceipt> = {},
): ParsedReceipt =>
  receipt({
    orderId: "S-1",
    total: items.reduce((sum, item) => sum + item.amount, 0),
    payee: "Lender",
    items,
    ...over,
  });

const component = (over: Partial<ParsedReceipt>): ParsedReceipt =>
  receipt({
    shippingCategoryId: CAT_SHIP,
    discountCategoryId: CAT_DISC,
    ...over,
  });

const found = (
  parsed: ParsedReceipt,
  over: Partial<JoinPart> = {},
  id = "comp-1",
  tagName: string | null = null,
): JoinPart => ({
  component: { receiptId: id, parsed, tagName },
  several: 1,
  taken: 0,
  ...over,
});

const none: JoinPart = { component: null, several: 0, taken: 0 };

const sum = (items: readonly ParsedReceiptItem[]): number =>
  items.reduce(
    (total, item) =>
      total + (item.kind === "discount" ? -item.amount : item.amount),
    0,
  );

/** Component 150,00 item x2 + shipping 13,00. */
const kopi = (): ParsedReceipt =>
  component({
    total: u(16300),
    shipping: u(1300),
    items: [
      { name: "KOPI 250 g", qty: 2, amount: u(15000), categoryId: CAT_GOODS },
    ],
  });

describe("joinSettlement truth table (spec 4.2)", () => {
  it("lists the outcomes a CHECK constraint holds", () => {
    expect([...RECEIPT_LINK_OUTCOMES]).toEqual([
      "no_link",
      "not_found",
      "component_incomplete",
      "component_used",
      "joined",
      "scaled",
      "amount_exceeds",
    ]);
  });

  it("no_link: the part stays one line", () => {
    const s = settlementOf([part(10000, null)]);
    const out = joinSettlement(s, [none]);
    expect(out.reports).toEqual([
      {
        partIndex: 0,
        link: null,
        partAmount: u(10000),
        outcome: "no_link",
        componentReceiptId: null,
      },
    ]);
    expect(hasJoinedPart(out.parsed)).toBe(false);
  });

  it("not_found: the part stays one line", () => {
    const s = settlementOf([part(10000, "a1")]);
    const out = joinSettlement(s, [none]);
    expect(out.reports[0].outcome).toBe("not_found");
    expect(out.parsed.items).toHaveLength(1);
    expect(out.parsed.items[0].link).toBeUndefined();
  });

  it("reports how many components a link found, when more than one", () => {
    const s = settlementOf([part(16300, "a1")]);
    const out = joinSettlement(s, [found(kopi(), { several: 3 })]);
    expect(out.reports[0].several).toBe(3);
    expect(out.reports[0].outcome).toBe("joined");
  });

  it("component_incomplete: the part stays, the report names the reason", () => {
    const s = settlementOf([part(16300, "a1")]);
    const broken = kopi();
    broken.complete = false;
    broken.reason = "items_uncategorized";
    const out = joinSettlement(s, [found(broken)]);
    expect(out.reports[0]).toMatchObject({
      outcome: "component_incomplete",
      componentReceiptId: "comp-1",
      componentReason: "items_uncategorized",
    });
    expect(out.parsed.items).toHaveLength(1);
    expect(out.componentReasons).toEqual([]);
  });

  it("component_used: nothing is left of the component", () => {
    const s = settlementOf([part(10000, "a1")]);
    const out = joinSettlement(s, [found(kopi(), { taken: u(16300) })]);
    expect(out.reports[0]).toMatchObject({
      outcome: "component_used",
      componentNet: u(16300),
      taken: u(16300),
    });
    expect(out.parsed.items).toHaveLength(1);
  });

  it("joined: a = N and taken = 0 takes the component's lines unchanged", () => {
    const s = settlementOf([part(16300, "a1", { instalment: "1 z 1" })]);
    const out = joinSettlement(s, [found(kopi())]);
    expect(out.reports[0].outcome).toBe("joined");
    expect(out.parsed.items).toEqual([
      {
        name: "KOPI 250 g",
        qty: 2,
        amount: u(15000),
        categoryId: CAT_GOODS,
        kind: "item",
      },
      {
        name: "shipping",
        qty: 1,
        amount: u(1300),
        categoryId: CAT_SHIP,
        kind: "shipping",
      },
    ]);
    expect(out.componentReasons).toEqual([
      { receiptId: "comp-1", reason: "settled" },
    ]);
  });

  it("scaled: a < R", () => {
    const s = settlementOf([part(8150, "a1", { instalment: "1. spłata z 2" })]);
    const out = joinSettlement(s, [found(kopi())]);
    expect(out.reports[0].outcome).toBe("scaled");
    expect(sum(out.parsed.items)).toBe(u(8150));
    expect(
      out.parsed.items.every((i) => i.instalment === "1. spłata z 2"),
    ).toBe(true);
    expect(out.componentReasons[0].reason).toBe("instalment");
  });

  it("scaled: a = R with taken > 0", () => {
    const s = settlementOf([part(10000, "a1")]);
    const c = component({
      items: [
        { name: "A", qty: 1, amount: u(20000), categoryId: CAT_GOODS },
        { name: "B", qty: 1, amount: u(10000), categoryId: CAT_GOODS },
      ],
      total: u(30000),
    });
    const out = joinSettlement(s, [found(c, { taken: u(20000) })]);
    expect(out.reports[0].outcome).toBe("scaled");
    expect(out.componentReasons[0].reason).toBe("settled");
  });

  it("amount_exceeds: a > R", () => {
    const s = settlementOf([part(40000, "a1")]);
    const c = component({
      items: [{ name: "A", qty: 1, amount: u(30000), categoryId: CAT_GOODS }],
      total: u(30000),
    });
    const out = joinSettlement(s, [found(c)]);
    expect(out.reports[0]).toMatchObject({
      outcome: "amount_exceeds",
      componentNet: u(30000),
      partAmount: u(40000),
    });
    expect(out.parsed.items).toHaveLength(1);
    expect(out.parsed.items[0].amount).toBe(u(40000));
  });
});

describe("joinSettlement examples", () => {
  it("spec 4.4: one part kept, one joined, with shipping", () => {
    const s = settlementOf([part(10989, "a1"), part(16300, "a2")], {
      total: u(27289),
    });
    const out = joinSettlement(s, [none, found(kopi())]);
    expect(out.reports.map((r) => r.outcome)).toEqual(["not_found", "joined"]);
    expect(out.parsed.items.map((i) => i.amount)).toEqual([
      u(10989),
      u(15000),
      u(1300),
    ]);
    expect(out.parsed.items[0].categoryId).toBe(CAT_PART);
    expect(sum(out.parsed.items)).toBe(u(27289));
    expect(out.parsed.complete).toBe(true);
    expect(out.parsed.total).toBe(u(27289));
    expect(out.parsed.orderId).toBe("S-1");
    expect(out.parsed.payee).toBe("Lender");
    expect(hasJoinedPart(out.parsed)).toBe(true);
    expect(out.parsed.links).toBe(out.reports);
  });

  it("spec 4.5: three instalments of one component", () => {
    const c = component({
      total: u(30000),
      items: [
        { name: "A", qty: 1, amount: u(20000), categoryId: CAT_GOODS },
        { name: "B", qty: 1, amount: u(10000), categoryId: CAT_GOODS },
      ],
    });
    const run = (taken: number) =>
      joinSettlement(settlementOf([part(10000, "a1")]), [
        found(c, { taken: u(taken) }),
      ]);
    const results = [run(0), run(10000), run(20000)];
    for (const r of results) {
      expect(r.parsed.items.map((i) => i.amount)).toEqual([u(6667), u(3333)]);
      expect(r.parsed.complete).toBe(true);
    }
    expect(results.map((r) => r.componentReasons[0].reason)).toEqual([
      "instalment",
      "instalment",
      "settled",
    ]);
  });

  it("scales a discount and keeps it negative", () => {
    const c = component({
      total: u(9000),
      discount: u(1000),
      items: [{ name: "A", qty: 1, amount: u(10000), categoryId: CAT_GOODS }],
    });
    const out = joinSettlement(settlementOf([part(4500, "a1")]), [found(c)]);
    expect(out.parsed.items).toEqual([
      {
        name: "A",
        qty: 1,
        amount: u(5000),
        categoryId: CAT_GOODS,
        kind: "item",
      },
      {
        name: "discount",
        qty: 1,
        amount: u(500),
        categoryId: CAT_DISC,
        kind: "discount",
      },
    ]);
    expect(sum(out.parsed.items)).toBe(u(4500));
    expect(out.parsed.complete).toBe(true);
  });

  it("joins a component with a discount and fees exactly", () => {
    const c = component({
      total: u(10000),
      shipping: u(500),
      fees: [u(300), 0, u(200)],
      feesCategoryId: CAT_SHIP,
      discount: u(1000),
      items: [{ name: "A", qty: 1, amount: u(10000), categoryId: CAT_GOODS }],
    });
    const out = joinSettlement(settlementOf([part(10000, "a1")]), [found(c)]);
    expect(out.reports[0].outcome).toBe("joined");
    expect(out.parsed.items.map((i) => [i.kind, i.name, i.amount])).toEqual([
      ["item", "A", u(10000)],
      ["shipping", "shipping", u(500)],
      ["fee", "fee", u(300)],
      ["fee", "fee", u(200)],
      ["discount", "discount", u(1000)],
    ]);
    expect(sum(out.parsed.items)).toBe(u(10000));
    expect(out.parsed.complete).toBe(true);
  });

  it("uses BigInt for a large component", () => {
    const big = 9_000_000_000 * 10000;
    const c = component({
      total: big,
      items: [
        { name: "A", qty: 1, amount: big / 3, categoryId: CAT_GOODS },
        { name: "B", qty: 1, amount: (big / 3) * 2, categoryId: CAT_GOODS },
      ],
    });
    const a = 3_000_000_000 * 10000;
    const s = settlementOf([{ ...part(0, "a1"), amount: a }]);
    const out = joinSettlement(s, [found(c)]);
    expect(out.reports[0].outcome).toBe("scaled");
    expect(out.parsed.items.map((i) => i.amount)).toEqual([a / 3, (a / 3) * 2]);
    expect(sum(out.parsed.items)).toBe(a);
  });

  it("gives the rest to the largest line, first on a tie", () => {
    // Three equal lines of 1,00 each, N = 3,00; a = 1,00: each 0,33; rest 0,01 to the first.
    const c = component({
      total: u(300),
      items: ["A", "B", "C"].map((name) => ({
        name,
        qty: 1,
        amount: u(100),
        categoryId: CAT_GOODS,
      })),
    });
    const out = joinSettlement(settlementOf([part(100, "a1")]), [found(c)]);
    expect(out.parsed.items.map((i) => i.amount)).toEqual([
      u(34),
      u(33),
      u(33),
    ]);
    // A larger line takes it instead.
    const c3 = component({
      total: u(700),
      items: [
        { name: "A", qty: 1, amount: u(200), categoryId: CAT_GOODS },
        { name: "B", qty: 1, amount: u(400), categoryId: CAT_GOODS },
        { name: "C", qty: 1, amount: u(100), categoryId: CAT_GOODS },
      ],
    });
    // a = 1,00: A 0,2857 -> 0,29; B 0,5714 -> 0,57; C 0,1429 -> 0,14; sum 1,00.
    const out3 = joinSettlement(settlementOf([part(100, "a1")]), [found(c3)]);
    expect(out3.parsed.items.map((i) => i.amount)).toEqual([
      u(29),
      u(57),
      u(14),
    ]);
  });

  it("drops a line scaled to zero and keeps the sum exact", () => {
    const c = component({
      total: u(100100),
      items: [
        { name: "Big", qty: 1, amount: u(100000), categoryId: CAT_GOODS },
        { name: "Tiny", qty: 1, amount: u(100), categoryId: CAT_GOODS },
      ],
    });
    // a = 1,00: Big 0,999 -> 1,00; Tiny 0,001 -> 0,00 (dropped).
    const out = joinSettlement(settlementOf([part(100, "a1")]), [found(c)]);
    expect(out.parsed.items.map((i) => i.name)).toEqual(["Big"]);
    expect(sum(out.parsed.items)).toBe(u(100));
  });

  it("keeps the sum exact when every line scales to zero", () => {
    const c = component({
      total: u(300),
      items: ["A", "B", "C"].map((name) => ({
        name,
        qty: 1,
        amount: u(100),
        categoryId: CAT_GOODS,
      })),
    });
    const out = joinSettlement(
      settlementOf([{ ...part(1, "a1"), amount: u(1) }]),
      [found(c)],
    );
    expect(sum(out.parsed.items)).toBe(u(1));
  });

  it("joins several components in one settlement and dedupes their tags", () => {
    const one = component({
      total: u(5000),
      items: [{ name: "A", qty: 1, amount: u(5000), categoryId: CAT_GOODS }],
    });
    const two = component({
      total: u(7000),
      items: [{ name: "B", qty: 1, amount: u(7000), categoryId: CAT_GOODS }],
    });
    const three = component({
      total: u(900),
      items: [{ name: "C", qty: 1, amount: u(900), categoryId: CAT_GOODS }],
    });
    const s = settlementOf([
      part(5000, "a1"),
      part(7000, "a2"),
      part(900, "a3"),
      part(300, null),
    ]);
    const out = joinSettlement(s, [
      found(one, {}, "c1", "Shop"),
      found(two, {}, "c2", "shop"),
      found(three, {}, "c3", null),
      none,
    ]);
    expect(out.parsed.items.map((i) => i.name)).toEqual([
      "A",
      "B",
      "C",
      "Part x",
    ]);
    expect(out.tagNames).toEqual(["Shop"]);
    expect(out.componentReasons.map((r) => r.receiptId)).toEqual([
      "c1",
      "c2",
      "c3",
    ]);
    expect(sum(out.parsed.items)).toBe(u(13200));
  });

  it("with no join, the items equal the settlement's minus link and instalment", () => {
    const items = [
      part(10989, "a1", { instalment: "1 z 3", categorySource: "history" }),
      part(16300, null),
      part(500, "a3"),
    ];
    const s = settlementOf(items);
    const out = joinSettlement(s, [none, none, none]);
    expect(out.parsed.items).toEqual(
      items.map(({ link: _l, instalment: _i, ...rest }) => rest),
    );
    expect(out.parsed).toMatchObject({
      orderId: s.orderId,
      total: s.total,
      payee: s.payee,
      complete: true,
      reason: null,
    });
    expect(out.reports.map((r) => r.outcome)).toEqual([
      "not_found",
      "no_link",
      "not_found",
    ]);
    expect(out.tagNames).toEqual([]);
    expect(out.componentReasons).toEqual([]);
    expect(hasJoinedPart(out.parsed)).toBe(false);
  });

  it("strips link and instalment from a component's own lines", () => {
    const c = component({
      total: u(5000),
      items: [
        {
          name: "A",
          qty: 1,
          amount: u(5000),
          categoryId: CAT_GOODS,
          link: "zz",
          instalment: "old",
        },
      ],
    });
    const out = joinSettlement(settlementOf([part(5000, "a1")]), [found(c)]);
    expect(out.parsed.items[0]).not.toHaveProperty("link");
    expect(out.parsed.items[0]).not.toHaveProperty("instalment");
  });
});
