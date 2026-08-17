import { TransactionStatus } from "../transactions/entities/transaction-status.enum";
import { applyQifClearedField, statusFromQifFlags } from "./qif-status.util";

describe("applyQifClearedField", () => {
  const apply = (value: string) => {
    const target: { cleared?: boolean; reconciled?: boolean } = {
      cleared: false,
      reconciled: false,
    };
    applyQifClearedField(target, value);
    return target;
  };

  // Quicken writes `*`/`c` for cleared and `X`/`R` for reconciled; the original
  // switch accepted only `*`/`X`/`x`, so `c` and `R` silently imported as
  // unreconciled.
  it.each([
    ["*", { cleared: true, reconciled: false }],
    ["c", { cleared: true, reconciled: false }],
    ["C", { cleared: true, reconciled: false }],
    ["X", { cleared: false, reconciled: true }],
    ["x", { cleared: false, reconciled: true }],
    ["R", { cleared: false, reconciled: true }],
    ["r", { cleared: false, reconciled: true }],
  ])("maps %j onto the flags", (value, expected) => {
    expect(apply(value)).toEqual(expected);
  });

  it("leaves both flags false for an unknown marker instead of throwing", () => {
    // An import must not fail on a marker it does not recognise.
    expect(apply("?")).toEqual({ cleared: false, reconciled: false });
  });

  it("trims whitespace padding before matching", () => {
    expect(apply("* ")).toEqual({ cleared: true, reconciled: false });
    expect(apply(" R")).toEqual({ cleared: false, reconciled: true });
  });

  it("never clears a flag another field already set", () => {
    const target = { cleared: true, reconciled: false };
    applyQifClearedField(target, "?");
    expect(target).toEqual({ cleared: true, reconciled: false });
  });
});

describe("statusFromQifFlags", () => {
  it("void outranks reconciled and cleared together", () => {
    expect(
      statusFromQifFlags({ void: true, reconciled: true, cleared: true }),
    ).toBe(TransactionStatus.VOID);
  });

  it("reconciled outranks cleared", () => {
    expect(statusFromQifFlags({ reconciled: true, cleared: true })).toBe(
      TransactionStatus.RECONCILED,
    );
  });

  it("cleared alone maps to CLEARED", () => {
    expect(statusFromQifFlags({ cleared: true })).toBe(
      TransactionStatus.CLEARED,
    );
  });

  it("no flags maps to UNRECONCILED", () => {
    expect(statusFromQifFlags({})).toBe(TransactionStatus.UNRECONCILED);
  });
});
