import {
  simplefinAccountId,
  simplefinTransactionKey,
} from "./simplefin.identity";
import { simplefinWindows } from "./simplefin.windows";
import { simplefinClaimUrl, simplefinAccessRequest } from "./simplefin.urls";

const origin = "https://beta-bridge.simplefin.org";
const token = (value: string) => Buffer.from(value).toString("base64");

describe("SimpleFIN provider identity", () => {
  it("scopes identical transaction IDs to their remote accounts and institutions", () => {
    const key = simplefinTransactionKey(origin, "bank-a", "checking", "tx-1");
    expect(key).not.toBe(
      simplefinTransactionKey(origin, "bank-a", "savings", "tx-1"),
    );
    expect(key).not.toBe(
      simplefinTransactionKey(origin, "bank-b", "checking", "tx-1"),
    );
    expect(key).not.toBe(
      simplefinTransactionKey(
        "https://bridge.simplefin.org",
        "bank-a",
        "checking",
        "tx-1",
      ),
    );
    expect(key).toMatch(/^simplefin:v1:[a-f0-9]{64}$/);
  });
  it("does not collapse ambiguous tuple concatenations", () => {
    expect(simplefinAccountId(origin, "ab", "c")).not.toBe(
      simplefinAccountId(origin, "a", "bc"),
    );
  });
  it("preserves account identity across reconnects without tokens or local connection IDs", () => {
    expect(simplefinAccountId(origin, "bank", "account")).toBe(
      simplefinAccountId(origin, "bank", "account"),
    );
  });
});

describe("SimpleFIN UTC request windows", () => {
  it("includes leap day without a gap at the exclusive end", () => {
    expect(simplefinWindows("2024-02-29", "2024-02-29")).toEqual([
      {
        startDate: Date.parse("2024-02-29T00:00:00Z") / 1000,
        endDate: Date.parse("2024-03-01T00:00:00Z") / 1000,
      },
    ]);
  });
  it("splits a 91-day range into contiguous 45, 45 and one-day requests", () => {
    const result = simplefinWindows("2024-01-01", "2024-03-31");
    expect(result).toHaveLength(3);
    expect(result[0].endDate - result[0].startDate).toBe(45 * 86400);
    expect(result[0].endDate).toBe(result[1].startDate);
    expect(result[1].endDate - result[1].startDate).toBe(45 * 86400);
    expect(result[1].endDate).toBe(result[2].startDate);
    expect(result[2].endDate - result[2].startDate).toBe(86400);
    expect(result[2].endDate).toBe(Date.parse("2024-04-01T00:00:00Z") / 1000);
  });
  it.each([
    ["2100-02-29", "2100-03-01"],
    ["2026-01-02", "2026-01-01"],
    ["2026-13-01", "2026-13-02"],
    ["bad", "2026-01-01"],
    ["1969-12-31", "1970-01-01"],
    ["9999-12-31", "9999-12-31"],
  ])("rejects invalid/unrepresentable ranges %s to %s", (from, to) => {
    expect(() => simplefinWindows(from, to)).toThrow();
  });
  it("does not vary across the daylight-saving transition", () => {
    const [window] = simplefinWindows("2025-03-08", "2025-03-10");
    expect(window.endDate - window.startDate).toBe(3 * 86400);
  });
});

describe("SimpleFIN URL boundaries", () => {
  it("accepts the documented Bridge claim flow", () => {
    expect(
      simplefinClaimUrl(token(origin + "/simplefin/claim/DEMO-token")).href,
    ).toBe(origin + "/simplefin/claim/DEMO-token");
  });
  it.each([
    "http://beta-bridge.simplefin.org/simplefin/claim/token",
    "https://beta-bridge.simplefin.org.evil.example/simplefin/claim/token",
    "https://127.0.0.1/simplefin/claim/token",
    "https://beta-bridge.simplefin.org:8443/simplefin/claim/token",
    "https://user:pass@beta-bridge.simplefin.org/simplefin/claim/token",
    origin + "/simplefin/claim/token?redirect=other",
    origin + "/simplefin/claim/token#fragment",
    origin + "/simplefin/claim/a/b",
  ])("rejects a hostile claim destination %s", (url) => {
    expect(() => simplefinClaimUrl(token(url))).toThrow();
  });
  it.each(["", "!!!", "YQ", "YQ==garbage", "A".repeat(16388)])(
    "rejects malformed tokens",
    (value) => {
      expect(() => simplefinClaimUrl(value)).toThrow();
    },
  );
  it("strips and decodes credentials before HTTP requests", () => {
    const result = simplefinAccessRequest(
      "https://name:p%40ss@beta-bridge.simplefin.org/simplefin",
    );
    expect(result.root.href).toBe(origin + "/simplefin");
    expect(result.authorization).toBe(
      "Basic " + Buffer.from("name:p@ss").toString("base64"),
    );
  });
  it.each([
    origin + "/simplefin",
    "https://u:p@evil.example/simplefin",
    "https://u:p@beta-bridge.simplefin.org/simplefin/claim/token",
    "https://u:p@beta-bridge.simplefin.org/other",
    "https://u%3Aname:p@beta-bridge.simplefin.org/simplefin",
    "https://u:p%0A@beta-bridge.simplefin.org/simplefin",
  ])("rejects invalid access URLs without echoing their secrets", (value) => {
    try {
      simplefinAccessRequest(value);
      throw new Error("Expected refusal");
    } catch (error) {
      expect((error as Error).message).not.toContain(value);
    }
  });
});
