import { IsHiddenTableColumnsConstraint } from "./is-hidden-table-columns.validator";
import {
  HIDDEN_COLUMN_TABLES,
  HIDEABLE_TABLE_COLUMNS,
} from "../hidden-table-columns";

describe("IsHiddenTableColumnsConstraint", () => {
  const validator = new IsHiddenTableColumnsConstraint();

  it("accepts undefined and null (optional)", () => {
    expect(validator.validate(undefined)).toBe(true);
    expect(validator.validate(null)).toBe(true);
  });

  it("accepts an empty object and an empty list per kind", () => {
    expect(validator.validate({})).toBe(true);
    expect(
      validator.validate({
        transactions: [],
        investmentHoldings: [],
        investmentRegister: [],
      }),
    ).toBe(true);
  });

  it.each(HIDDEN_COLUMN_TABLES)("accepts %s with its full list", (table) => {
    expect(
      validator.validate({ [table]: [...HIDEABLE_TABLE_COLUMNS[table]] }),
    ).toBe(true);
  });

  it("accepts the documented example", () => {
    expect(
      validator.validate({
        transactions: ["refNumber", "attachments"],
        investmentHoldings: [],
        investmentRegister: ["status"],
      }),
    ).toBe(true);
  });

  it("rejects arrays at the top level", () => {
    expect(validator.validate([])).toBe(false);
    expect(validator.validate([["refNumber"]])).toBe(false);
  });

  it("rejects non-object top-level values", () => {
    expect(validator.validate("transactions")).toBe(false);
    expect(validator.validate(42)).toBe(false);
    expect(validator.validate(true)).toBe(false);
  });

  it("rejects an unknown table kind", () => {
    expect(validator.validate({ budgets: [] })).toBe(false);
    expect(validator.validate({ Transactions: ["status"] })).toBe(false);
  });

  it("rejects dangerous keys", () => {
    // Build real own keys (a JSON payload does exactly this); the literal
    // { __proto__: [] } would set the prototype instead.
    expect(validator.validate(JSON.parse('{"__proto__": []}'))).toBe(false);
    expect(validator.validate(JSON.parse('{"constructor": []}'))).toBe(false);
    expect(validator.validate(JSON.parse('{"prototype": []}'))).toBe(false);
  });

  it("rejects a value that is not an array", () => {
    expect(validator.validate({ transactions: "status" })).toBe(false);
    expect(validator.validate({ transactions: { 0: "status" } })).toBe(false);
    expect(validator.validate({ transactions: null })).toBe(false);
  });

  it("rejects an id outside the kind's list", () => {
    expect(validator.validate({ transactions: ["amount"] })).toBe(false);
    // A real id of another kind is still unknown to this one.
    expect(validator.validate({ investmentRegister: ["avgCost"] })).toBe(false);
  });

  it("rejects a non-string id", () => {
    expect(validator.validate({ transactions: [1] })).toBe(false);
    expect(validator.validate({ transactions: [null] })).toBe(false);
    expect(validator.validate({ transactions: [["status"]] })).toBe(false);
  });

  it("rejects a duplicate id", () => {
    expect(validator.validate({ transactions: ["status", "status"] })).toBe(
      false,
    );
  });

  it("rejects a list longer than the kind's list", () => {
    const full = [...HIDEABLE_TABLE_COLUMNS.investmentRegister];
    expect(validator.validate({ investmentRegister: [...full, full[0]] })).toBe(
      false,
    );
  });

  it("refuses the whole map when one entry is bad, never dropping it", () => {
    expect(
      validator.validate({
        transactions: ["status"],
        investmentHoldings: ["nope"],
      }),
    ).toBe(false);
  });

  it("names the field in its default message", () => {
    expect(validator.defaultMessage()).toContain("hiddenTableColumns");
  });
});
