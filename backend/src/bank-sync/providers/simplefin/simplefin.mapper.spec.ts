import { requestContextStorage } from "../../../common/request-context";
import demo from "./fixtures/bridge-demo-v2.json";
import {
  mapSimplefinAccountSet,
  simplefinAccountBlocked,
  mapSimplefinTransaction,
} from "./simplefin.mapper";

const origin = "https://beta-bridge.simplefin.org";
const posted = Date.parse("2024-02-29T23:59:59Z") / 1000;
const transaction = (changes: Record<string, unknown> = {}) => ({
  id: "tx-1",
  amount: "-12.34",
  posted,
  description: "Groceries",
  ...changes,
});
const account = (changes: Record<string, unknown> = {}) => ({
  id: "checking",
  conn_id: "bank",
  name: "Checking",
  currency: "USD",
  balance: "100.00",
  "balance-date": posted,
  transactions: [transaction()],
  ...changes,
});
const payload = (changes: Record<string, unknown> = {}) => ({
  errlist: [],
  connections: [
    {
      conn_id: "bank",
      name: "Bank",
      org_id: "bank-org",
      sfin_url: origin + "/simplefin",
    },
  ],
  accounts: [account()],
  ...changes,
});
const map = (changes: Record<string, unknown> = {}) =>
  mapSimplefinAccountSet(payload(changes), origin);

describe("SimpleFIN public v2 mapping", () => {
  it("reads the actual published Bridge demo including optional unknown holdings", () => {
    const result = mapSimplefinAccountSet(demo, origin);
    expect(result.accounts).toHaveLength(3);
    expect(result.connections).toHaveLength(1);
    expect(
      result.accounts.every((row) => row.descriptor.currencyCode === "USD"),
    ).toBe(true);
    expect(result.accounts[0].transactions.length).toBeGreaterThan(0);
    expect(result.accounts[0].transactions[0].operation.code).toBeNull();
  });
  it.each([
    null,
    {},
    { errlist: [], accounts: [] },
    { errlist: "error", accounts: [], connections: [] },
  ])(
    "refuses an invalid top-level response rather than reporting an empty success",
    (value) => {
      expect(() => mapSimplefinAccountSet(value, origin)).toThrow();
    },
  );
  it("does not guess account type or a bank-account number from names or opaque IDs", () => {
    const result = map().accounts[0];
    expect(result.descriptor.cashAccountType).toBeNull();
    expect(result.descriptor.accountIdentifier).toBeNull();
    expect(result.descriptor.identifierMasked).toBeNull();
  });
  it("preserves balance decimal text, source timestamp, and UTC date", () => {
    const result = map().accounts[0];
    expect(result.balance).toMatchObject({
      amount: "100.00",
      currencyCode: "USD",
      referenceDate: "2024-02-29",
    });
    expect(result.balanceTimestamp).toBe(posted);
  });
  it("does not replace missing balance with available balance or zero", () => {
    const result = map({
      accounts: [account({ balance: null, "available-balance": "99" })],
    });
    expect(result.accounts[0].balance).toBeNull();
  });
  it("rejects custom currency URLs without fetching them", () => {
    expect(
      map({ accounts: [account({ currency: "https://example.com/points" })] })
        .accounts[0].descriptor.currencyCode,
    ).toBeNull();
  });
  it("marks a missing transactions array incomplete; an explicit empty array is complete", () => {
    expect(
      map({ accounts: [account({ transactions: undefined })] }).accounts[0]
        .transactionsComplete,
    ).toBe(false);
    expect(
      map({ accounts: [account({ transactions: [] })] }).accounts[0]
        .transactionsComplete,
    ).toBe(true);
  });
  it("refuses repeated account identities and unknown institution references", () => {
    expect(() => map({ accounts: [account(), account()] })).toThrow();
    expect(() =>
      map({ accounts: [account({ conn_id: "unknown" })] }),
    ).toThrow();
  });
});

describe("SimpleFIN booked transaction mapping", () => {
  const read = (changes: Record<string, unknown> = {}) =>
    mapSimplefinTransaction(
      transaction(changes),
      origin,
      "bank",
      "checking",
      "USD",
    );
  it.each([
    ["-12.34", "debit", "12.34"],
    ["25.00", "credit", "25.00"],
    ["0", "credit", "0"],
    ["-0.0001", "debit", "0.0001"],
    ["9999999999999999.9999", "credit", "9999999999999999.9999"],
  ])(
    "preserves %s as %s without float rounding",
    (amount, direction, absolute) => {
      expect(read({ amount })).toMatchObject({
        amount: absolute,
        direction,
        booked: true,
        bookingDate: "2024-02-29",
      });
    },
  );
  it.each([
    "0.00005",
    "10000000000000000",
    "NaN",
    "1e3",
    "",
    "1,234.00",
    null,
    12.34,
  ])("refuses malformed or unsupported money %s", (amount) =>
    expect(read({ amount })).toBeNull(),
  );
  it.each([0, -1, "1710000000", Number.POSITIVE_INFINITY, 253402300800])(
    "does not turn an invalid posted timestamp into today",
    (value) => expect(read({ posted: value })).toBeNull(),
  );
  it("skips pending rows and imports their later booked form once", () => {
    expect(read({ pending: true, posted: 0 })).toBeNull();
    expect(read({ pending: false })).not.toBeNull();
  });
  it("refuses missing IDs and non-boolean pending markers", () => {
    expect(read({ id: "" })).toBeNull();
    expect(read({ pending: "true" })).toBeNull();
  });
  it("keeps keys stable when description changes and distinct across accounts", () => {
    const first = read()!;
    expect(read({ description: "Updated description" })!.externalKey).toBe(
      first.externalKey,
    );
    expect(
      mapSimplefinTransaction(transaction(), origin, "bank", "savings", "USD")!
        .externalKey,
    ).not.toBe(first.externalKey);
  });
  it("does not invent an operation type from the description", () => {
    expect(
      read({ description: "CARD-PAYMENT" })!.operation.remittanceCode,
    ).toBeNull();
  });
});

describe("SimpleFIN scoped failure handling", () => {
  it("blocks only the matching institution or account when scope is supplied", () => {
    const result = map({
      errlist: [{ code: "con.auth", msg: "Login again", conn_id: "bank" }],
    });
    expect(simplefinAccountBlocked(result.errors, "bank", "checking")).toBe(
      true,
    );
    expect(simplefinAccountBlocked(result.errors, "other", "checking")).toBe(
      false,
    );
  });
  it.each(["act.failed", "act.missingdata", "act.unknown"])(
    "blocks incomplete account data for %s",
    (code) => {
      const result = map({
        errlist: [{ code, msg: "Incomplete", account_id: "checking" }],
      });
      expect(simplefinAccountBlocked(result.errors, "bank", "checking")).toBe(
        true,
      );
      expect(simplefinAccountBlocked(result.errors, "bank", "savings")).toBe(
        false,
      );
    },
  );
  it.each([
    { code: "gen.auth", msg: "Denied" },
    { code: "mystery", msg: "Unknown" },
    { code: "act.failed", msg: "Unscoped" },
  ])("blocks all accounts for global/unknown/unscoped failures", (error) => {
    expect(
      simplefinAccountBlocked(
        map({ errlist: [error] }).errors,
        "bank",
        "checking",
      ),
    ).toBe(true);
  });
  it("does not silently ignore legacy warnings", () => {
    expect(
      simplefinAccountBlocked(
        map({ errors: ["Request quota exceeded"] }).errors,
        "bank",
        "checking",
      ),
    ).toBe(true);
  });
  it.each([
    ["America/Toronto", "2026-10-16T00:30:00Z", "2026-10-15"],
    ["Asia/Tokyo", "2026-10-15T16:30:00Z", "2026-10-16"],
    ["America/Toronto", "2026-03-08T07:30:00Z", "2026-03-08"],
    ["America/Toronto", "2026-11-01T06:30:00Z", "2026-11-01"],
  ])("uses %s for the booking date at %s", (timezone, at, expected) => {
    requestContextStorage.run({ timezone }, () => {
      const result = mapSimplefinTransaction(
        transaction({ posted: Date.parse(at) / 1000 }),
        origin,
        "bank",
        "checking",
        "USD",
      );
      expect(result?.bookingDate).toBe(expected);
    });
  });
  it("allows absent display text without inventing a financial fact", () => {
    expect(
      mapSimplefinTransaction(
        transaction({ description: "" }),
        origin,
        "bank",
        "checking",
        "USD",
      ),
    ).toMatchObject({ remittance: [], amount: "12.34" });
  });
});
