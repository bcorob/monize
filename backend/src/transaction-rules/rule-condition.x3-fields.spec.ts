import { TransactionStatus } from "../transactions/entities/transaction-status.enum";
import { evaluateRuleCondition } from "./rule-condition.evaluator";
import {
  RULE_CONDITION_FIELDS,
  RULE_TRANSACTION_STATUSES,
  RULE_WEEKDAYS,
  RuleConditionLeaf,
  RuleFacts,
} from "./rule-condition.types";
import { buildRuleFacts, calendarDayParts } from "./rule-facts";
import { validateRuleDefinition } from "./rule-validation";

/**
 * The fields of design 10.3 (X3): referenceNumber, dayOfMonth, weekday,
 * status, hasAttachment. Run this file under TZ=UTC and under
 * TZ=Pacific/Kiritimati (UTC+14) and TZ=Pacific/Pago_Pago (UTC-11): a
 * calendar date must name the same day and weekday in every zone.
 */
const BASE = {
  accountId: "acc-1",
  currencyCode: "PLN",
  amount: -10,
  isTransfer: false,
  payeeId: null,
  payeeText: null,
  categoryId: null,
  description: null,
  tagIds: [] as string[],
  hasSplits: false,
};

const facts = (over: Partial<Parameters<typeof buildRuleFacts>[0]> = {}) =>
  buildRuleFacts({ ...BASE, ...over });

const leaf = (
  field: RuleConditionLeaf["field"],
  op: RuleConditionLeaf["op"],
  value?: RuleConditionLeaf["value"],
): RuleConditionLeaf =>
  value === undefined ? { field, op } : { field, op, value };

const ev = (node: RuleConditionLeaf, f: RuleFacts): boolean =>
  evaluateRuleCondition(node, f);

describe("calendarDayParts", () => {
  it.each([
    ["2026-03-01", 1, "SUN"],
    ["2026-01-31", 31, "SAT"],
    ["2026-02-28", 28, "SAT"],
    ["2024-02-29", 29, "THU"],
    ["2026-12-31", 31, "THU"],
    ["2026-01-01", 1, "THU"],
    ["2000-01-01", 1, "SAT"],
    ["2026-09-28", 28, "MON"],
    ["2026-09-27", 27, "SUN"],
  ])("%s is day %i, %s in every timezone", (date, day, weekday) => {
    expect(calendarDayParts(date)).toEqual({ dayOfMonth: day, weekday });
  });

  it("reads the digits, not the clock: the same answer as a UTC computation", () => {
    for (let d = 0; d < 800; d += 7) {
      const at = new Date(Date.UTC(2025, 0, 1 + d));
      const text = at.toISOString().slice(0, 10);
      expect(calendarDayParts(text)?.dayOfMonth).toBe(at.getUTCDate());
      expect(RULE_WEEKDAYS.indexOf(calendarDayParts(text)!.weekday)).toBe(
        (at.getUTCDay() + 6) % 7,
      );
    }
  });

  it("is unknown for anything that is not a real YYYY-MM-DD date", () => {
    for (const bad of [
      null,
      undefined,
      "",
      "2026-02-30",
      "2026-13-01",
      "2026-00-10",
      "2026-1-1",
      "2026-03-01T00:00:00Z",
      "01/03/2026",
      "not a date",
    ]) {
      expect(calendarDayParts(bad as never)).toBeNull();
    }
    expect(calendarDayParts(new Date(2026, 2, 1) as never)).toBeNull();
  });
});

describe("buildRuleFacts: the X3 facts", () => {
  it("defaults to unknown: null reference, date and status, no attachment", () => {
    expect(facts()).toEqual(
      expect.objectContaining({
        referenceNumber: null,
        dayOfMonth: null,
        weekday: null,
        status: null,
        hasAttachment: false,
      }),
    );
  });

  it("carries the reference, status, derived date parts and attachment", () => {
    expect(
      facts({
        referenceNumber: "CHK-77",
        transactionDate: "2026-03-01",
        status: "CLEARED",
        hasAttachment: true,
      }),
    ).toEqual(
      expect.objectContaining({
        referenceNumber: "CHK-77",
        dayOfMonth: 1,
        weekday: "SUN",
        status: "CLEARED",
        hasAttachment: true,
      }),
    );
  });
});

describe("field table", () => {
  it("lists the status values of the entity's enum, in both directions", () => {
    expect([...RULE_TRANSACTION_STATUSES].sort()).toEqual(
      Object.values(TransactionStatus).sort(),
    );
  });

  it("gives the fields of design 10.3 their operators", () => {
    const ops = (f: keyof typeof RULE_CONDITION_FIELDS) => [
      ...RULE_CONDITION_FIELDS[f].operators,
    ];
    expect(ops("referenceNumber")).toEqual([
      "eq",
      "contains",
      "startsWith",
      "matches",
      "isEmpty",
    ]);
    expect(ops("dayOfMonth")).toEqual([
      "eq",
      "lt",
      "lte",
      "gt",
      "gte",
      "between",
      "in",
    ]);
    expect(ops("weekday")).toEqual(["eq", "in"]);
    expect(ops("status")).toEqual(["eq", "neq", "in"]);
    expect(ops("hasAttachment")).toEqual(["eq"]);
  });
});

describe("evaluate: referenceNumber", () => {
  const f = facts({ referenceNumber: "  CHK-0042 " });
  it("eq, contains and startsWith compare trimmed and case-insensitively", () => {
    expect(ev(leaf("referenceNumber", "eq", "chk-0042"), f)).toBe(true);
    expect(ev(leaf("referenceNumber", "eq", "CHK-42"), f)).toBe(false);
    expect(ev(leaf("referenceNumber", "contains", "-00"), f)).toBe(true);
    expect(ev(leaf("referenceNumber", "contains", "-99"), f)).toBe(false);
    expect(ev(leaf("referenceNumber", "startsWith", "chk"), f)).toBe(true);
    expect(ev(leaf("referenceNumber", "startsWith", "0042"), f)).toBe(false);
  });

  it("matches is a glob", () => {
    expect(ev(leaf("referenceNumber", "matches", "CHK-*"), f)).toBe(true);
    expect(ev(leaf("referenceNumber", "matches", "*-0042"), f)).toBe(true);
    expect(ev(leaf("referenceNumber", "matches", "INV-*"), f)).toBe(false);
  });

  it("isEmpty is true for a missing, null or blank reference only", () => {
    expect(ev(leaf("referenceNumber", "isEmpty"), f)).toBe(false);
    expect(ev(leaf("referenceNumber", "isEmpty"), facts())).toBe(true);
    expect(
      ev(leaf("referenceNumber", "isEmpty"), facts({ referenceNumber: " " })),
    ).toBe(true);
  });

  it("a missing reference is false for every other operator", () => {
    const none = facts();
    for (const op of ["eq", "contains", "startsWith", "matches"] as const) {
      expect(ev(leaf("referenceNumber", op, "x"), none)).toBe(false);
    }
  });
});

describe("evaluate: dayOfMonth", () => {
  const on = (date: string) => facts({ transactionDate: date });
  it("eq, lt, lte, gt, gte", () => {
    const f = on("2026-03-15");
    expect(ev(leaf("dayOfMonth", "eq", 15), f)).toBe(true);
    expect(ev(leaf("dayOfMonth", "eq", 14), f)).toBe(false);
    expect(ev(leaf("dayOfMonth", "lt", 16), f)).toBe(true);
    expect(ev(leaf("dayOfMonth", "lt", 15), f)).toBe(false);
    expect(ev(leaf("dayOfMonth", "lte", 15), f)).toBe(true);
    expect(ev(leaf("dayOfMonth", "lte", 14), f)).toBe(false);
    expect(ev(leaf("dayOfMonth", "gt", 14), f)).toBe(true);
    expect(ev(leaf("dayOfMonth", "gt", 15), f)).toBe(false);
    expect(ev(leaf("dayOfMonth", "gte", 15), f)).toBe(true);
    expect(ev(leaf("dayOfMonth", "gte", 16), f)).toBe(false);
  });

  it("between is inclusive and in takes a list", () => {
    const f = on("2026-03-15");
    expect(ev(leaf("dayOfMonth", "between", [15, 20]), f)).toBe(true);
    expect(ev(leaf("dayOfMonth", "between", [10, 15]), f)).toBe(true);
    expect(ev(leaf("dayOfMonth", "between", [16, 20]), f)).toBe(false);
    expect(ev(leaf("dayOfMonth", "in", [1, 15, 31]), f)).toBe(true);
    expect(ev(leaf("dayOfMonth", "in", [1, 31]), f)).toBe(false);
  });

  it("month boundaries: the first, the 28th to 31st and a leap day", () => {
    expect(ev(leaf("dayOfMonth", "eq", 1), on("2026-03-01"))).toBe(true);
    expect(ev(leaf("dayOfMonth", "eq", 31), on("2026-01-31"))).toBe(true);
    expect(ev(leaf("dayOfMonth", "eq", 31), on("2026-04-30"))).toBe(false);
    expect(ev(leaf("dayOfMonth", "eq", 30), on("2026-04-30"))).toBe(true);
    expect(ev(leaf("dayOfMonth", "gte", 28), on("2026-02-28"))).toBe(true);
    expect(ev(leaf("dayOfMonth", "eq", 29), on("2024-02-29"))).toBe(true);
    expect(ev(leaf("dayOfMonth", "eq", 1), on("2026-12-31"))).toBe(false);
    expect(ev(leaf("dayOfMonth", "eq", 31), on("2026-12-31"))).toBe(true);
    expect(ev(leaf("dayOfMonth", "eq", 1), on("2027-01-01"))).toBe(true);
  });

  it("an unknown date is false for every operator", () => {
    const none = facts();
    expect(ev(leaf("dayOfMonth", "eq", 1), none)).toBe(false);
    expect(ev(leaf("dayOfMonth", "gte", 1), none)).toBe(false);
    expect(ev(leaf("dayOfMonth", "between", [1, 31]), none)).toBe(false);
    expect(ev(leaf("dayOfMonth", "in", [1]), none)).toBe(false);
  });
});

describe("evaluate: weekday", () => {
  it("names the weekday of the calendar date, whatever the server timezone", () => {
    // 2026-03-01 is a Sunday. A Date parsed from it is UTC midnight, which is
    // still Saturday in every zone west of UTC; the fact must not follow it.
    const f = facts({ transactionDate: "2026-03-01" });
    expect(ev(leaf("weekday", "eq", "SUN"), f)).toBe(true);
    expect(ev(leaf("weekday", "eq", "SAT"), f)).toBe(false);
    expect(ev(leaf("weekday", "eq", "MON"), f)).toBe(false);
    const monday = facts({ transactionDate: "2026-09-28" });
    expect(ev(leaf("weekday", "eq", "MON"), monday)).toBe(true);
    expect(ev(leaf("weekday", "eq", "SUN"), monday)).toBe(false);
  });

  it("in takes a list and the value compares case-insensitively", () => {
    const f = facts({ transactionDate: "2026-03-01" });
    expect(ev(leaf("weekday", "in", ["SAT", "SUN"]), f)).toBe(true);
    expect(ev(leaf("weekday", "in", ["MON", "TUE"]), f)).toBe(false);
    expect(ev(leaf("weekday", "eq", "sun"), f)).toBe(true);
  });

  it("every weekday of one week is named once", () => {
    const week = [
      "2026-09-28",
      "2026-09-29",
      "2026-09-30",
      "2026-10-01",
      "2026-10-02",
      "2026-10-03",
      "2026-10-04",
    ];
    week.forEach((date, i) => {
      const f = facts({ transactionDate: date });
      expect(
        RULE_WEEKDAYS.filter((d) => ev(leaf("weekday", "eq", d), f)),
      ).toEqual([RULE_WEEKDAYS[i]]);
    });
  });

  it("an unknown date is false", () => {
    expect(ev(leaf("weekday", "eq", "MON"), facts())).toBe(false);
    expect(ev(leaf("weekday", "in", ["MON"]), facts())).toBe(false);
  });
});

describe("evaluate: status", () => {
  const f = facts({ status: "CLEARED" });
  it("eq, neq and in", () => {
    expect(ev(leaf("status", "eq", "CLEARED"), f)).toBe(true);
    expect(ev(leaf("status", "eq", "VOID"), f)).toBe(false);
    expect(ev(leaf("status", "neq", "VOID"), f)).toBe(true);
    expect(ev(leaf("status", "neq", "CLEARED"), f)).toBe(false);
    expect(ev(leaf("status", "in", ["VOID", "CLEARED"]), f)).toBe(true);
    expect(ev(leaf("status", "in", ["VOID", "RECONCILED"]), f)).toBe(false);
  });

  it("an unknown status is false, neq included", () => {
    const none = facts();
    expect(ev(leaf("status", "eq", "CLEARED"), none)).toBe(false);
    expect(ev(leaf("status", "neq", "CLEARED"), none)).toBe(false);
    expect(ev(leaf("status", "in", ["CLEARED"]), none)).toBe(false);
  });
});

describe("evaluate: hasAttachment", () => {
  it("eq true / false", () => {
    const yes = facts({ hasAttachment: true });
    const no = facts();
    expect(ev(leaf("hasAttachment", "eq", true), yes)).toBe(true);
    expect(ev(leaf("hasAttachment", "eq", false), yes)).toBe(false);
    expect(ev(leaf("hasAttachment", "eq", true), no)).toBe(false);
    expect(ev(leaf("hasAttachment", "eq", false), no)).toBe(true);
  });

  it("does not read hasSplits", () => {
    const f = facts({ hasSplits: true });
    expect(ev(leaf("hasAttachment", "eq", true), f)).toBe(false);
    expect(ev(leaf("hasSplits", "eq", true), f)).toBe(true);
  });
});

describe("validate: the X3 fields", () => {
  const codes = (node: unknown) =>
    validateRuleDefinition({
      condition: node,
      actions: [
        { type: "add_tags", tagIds: ["11111111-1111-4111-8111-111111111111"] },
      ],
    }).map((e) => e.code);

  it("accepts well-formed leaves", () => {
    for (const node of [
      leaf("referenceNumber", "eq", "CHK-1"),
      leaf("referenceNumber", "matches", "CHK-{n}"),
      leaf("referenceNumber", "isEmpty"),
      leaf("dayOfMonth", "eq", 1),
      leaf("dayOfMonth", "gte", 31),
      leaf("dayOfMonth", "between", [1, 31]),
      leaf("dayOfMonth", "in", [1, 15, 31]),
      leaf("weekday", "eq", "MON"),
      leaf("weekday", "in", ["SAT", "SUN"]),
      leaf("status", "neq", "VOID"),
      leaf("status", "in", ["CLEARED", "RECONCILED"]),
      leaf("hasAttachment", "eq", false),
    ]) {
      expect(codes(node)).toEqual([]);
    }
  });

  it("refuses a day outside 1..31, a fraction and a non-number", () => {
    expect(codes(leaf("dayOfMonth", "eq", 0))).toEqual(["VALUE_OUT_OF_RANGE"]);
    expect(codes(leaf("dayOfMonth", "eq", 32))).toEqual(["VALUE_OUT_OF_RANGE"]);
    expect(codes(leaf("dayOfMonth", "eq", 1.5))).toEqual([
      "VALUE_OUT_OF_RANGE",
    ]);
    expect(codes(leaf("dayOfMonth", "eq", "5"))).toEqual(["VALUE_TYPE"]);
    expect(codes(leaf("dayOfMonth", "in", [1, 40]))).toEqual([
      "VALUE_OUT_OF_RANGE",
    ]);
    expect(codes(leaf("dayOfMonth", "in", []))).toEqual(["ARRAY_EMPTY"]);
  });

  it("checks the range shape and its order", () => {
    expect(codes(leaf("dayOfMonth", "between", [20, 10]))).toEqual([
      "RANGE_ORDER",
    ]);
    expect(codes(leaf("dayOfMonth", "between", [1]))).toEqual(["VALUE_TYPE"]);
    expect(codes(leaf("dayOfMonth", "between", [0, 5]))).toEqual([
      "VALUE_OUT_OF_RANGE",
    ]);
  });

  it("refuses an unknown weekday or status and an operator the field lacks", () => {
    expect(codes(leaf("weekday", "eq", "MONDAY"))).toEqual(["INVALID_ENUM"]);
    expect(codes(leaf("weekday", "eq", "mon"))).toEqual(["INVALID_ENUM"]);
    expect(codes(leaf("weekday", "neq", "MON"))).toEqual([
      "OPERATOR_NOT_ALLOWED",
    ]);
    expect(codes(leaf("status", "eq", "PENDING"))).toEqual(["INVALID_ENUM"]);
    expect(codes(leaf("status", "notIn", ["VOID"]))).toEqual([
      "OPERATOR_NOT_ALLOWED",
    ]);
    expect(codes(leaf("hasAttachment", "eq", "yes"))).toEqual(["VALUE_TYPE"]);
    expect(codes(leaf("hasAttachment", "neq", true))).toEqual([
      "OPERATOR_NOT_ALLOWED",
    ]);
    expect(codes(leaf("dayOfMonth", "contains", 1))).toEqual([
      "OPERATOR_NOT_ALLOWED",
    ]);
    expect(codes(leaf("referenceNumber", "eq", 5))).toEqual(["VALUE_TYPE"]);
    expect(codes(leaf("referenceNumber", "isEmpty", "x"))).toEqual([
      "VALUE_NOT_ALLOWED",
    ]);
  });
});
