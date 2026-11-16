import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  ASSET_CLASS_KEYS,
  ASSET_CLASS_LABELS,
  SECURITY_TYPE_TO_ASSET_CLASS,
  canonicalAssetClassKey,
} from "./security-enums";

describe("canonicalAssetClassKey", () => {
  it("maps Yahoo's fund breakdown names and the type defaults to the same keys", () => {
    expect(canonicalAssetClassKey("Stocks")).toBe("equity");
    expect(canonicalAssetClassKey(SECURITY_TYPE_TO_ASSET_CLASS.STOCK)).toBe(
      "equity",
    );
    expect(canonicalAssetClassKey("Bonds")).toBe("fixedIncome");
    expect(canonicalAssetClassKey(SECURITY_TYPE_TO_ASSET_CLASS.BOND)).toBe(
      "fixedIncome",
    );
    expect(canonicalAssetClassKey("Cash")).toBe("cash");
    expect(canonicalAssetClassKey("Preferred")).toBe("preferred");
    expect(canonicalAssetClassKey("Convertible")).toBe("convertible");
  });

  it("names every Yahoo breakdown position a canonical class", () => {
    // The names `parseAssetPositions` writes, read from its source so a
    // position added there without an alias here fails.
    const source = readFileSync(
      resolve(__dirname, "yahoo-finance.service.ts"),
      "utf8",
    );
    const body = /private parseAssetPositions\([\s\S]*?\n {2}\}\n/.exec(
      source,
    )?.[0];
    expect(body).toBeDefined();
    const names = [...body!.matchAll(/name: "([^"]+)"/g)].map((m) => m[1]);
    expect(names.length).toBeGreaterThan(0);
    for (const name of names) {
      expect([name, canonicalAssetClassKey(name)]).toEqual([
        name,
        expect.any(String),
      ]);
    }
  });

  it("reads each key and its English label back as that key", () => {
    for (const key of ASSET_CLASS_KEYS) {
      expect(canonicalAssetClassKey(key)).toBe(key);
      expect(canonicalAssetClassKey(ASSET_CLASS_LABELS[key])).toBe(key);
    }
  });

  it("ignores case, spacing, punctuation and '&'", () => {
    expect(canonicalAssetClassKey("  FIXED   income ")).toBe("fixedIncome");
    expect(canonicalAssetClassKey("Cash & Equivalents")).toBe("cash");
    expect(canonicalAssetClassKey("equities.")).toBe("equity");
  });

  it("returns null for a class the user invented", () => {
    expect(canonicalAssetClassKey("Real Estate")).toBeNull();
    expect(canonicalAssetClassKey("")).toBeNull();
    expect(canonicalAssetClassKey(null)).toBeNull();
  });
});
