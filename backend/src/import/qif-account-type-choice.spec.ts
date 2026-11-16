import {
  accountsMissingType,
  applyAccountTypeChoices,
} from "./qif-account-type-choice";
import type { QifAccountBlock } from "./qif-parser";

function block(
  accountName: string,
  accountType: string | null,
): QifAccountBlock {
  return {
    accountName,
    accountType,
    description: "",
    creditLimit: null,
    transactions: [],
    categories: [],
    transferAccounts: [],
    securities: [],
    openingBalance: null,
    openingBalanceDate: null,
  };
}

describe("applyAccountTypeChoices", () => {
  it("fills an unknown type with the user's choice for that name", () => {
    const blocks = [block("Old Wallet", null)];
    const result = applyAccountTypeChoices(blocks, [
      { accountName: "Old Wallet", accountType: "CASH" },
    ]);
    expect(result[0].accountType).toBe("CASH");
    // The parsed blocks are not mutated.
    expect(blocks[0].accountType).toBeNull();
  });

  it("keeps a type the file names even when a choice is sent for it", () => {
    const result = applyAccountTypeChoices(
      [block("Visa", "CREDIT_CARD")],
      [{ accountName: "Visa", accountType: "LOAN" }],
    );
    expect(result[0].accountType).toBe("CREDIT_CARD");
  });

  it("leaves an unknown type unknown when no choice names it", () => {
    const result = applyAccountTypeChoices([block("Old Wallet", null)]);
    expect(result[0].accountType).toBeNull();
  });
});

describe("accountsMissingType", () => {
  it("names each untyped account once and ignores nameless blocks", () => {
    expect(
      accountsMissingType([
        block("A", null),
        block("A", null),
        block("B", "CHEQUING"),
        block("", null),
      ]),
    ).toEqual(["A"]);
  });
});
