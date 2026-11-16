import { EnableBankingReader } from "./enable-banking.reader";
import { fakeProvider, bankTransaction } from "../../bank-sync-testing";

describe("Enable Banking common read contract", () => {
  it("retains complete transactions when an independent balance read fails", async () => {
    const provider = fakeProvider();
    provider.fetchTransactions.mockResolvedValue([bankTransaction()]);
    const failure = new Error("balance unavailable");
    provider.fetchBalance.mockRejectedValue(failure);
    const read = await new EnableBankingReader(provider).readAccount(
      "owner",
      { applicationId: "test", privateKeyPem: "synthetic" },
      "account",
      { dateFrom: "2026-01-01", dateTo: "2026-01-02" },
    );
    expect(read.balanceFailure).toBe(failure);
    expect(read).toMatchObject({
      transactions: [bankTransaction()],
      balance: null,
      pending: 0,
      currencyCode: null,
    });
  });
  it("does not present failed transaction pagination as a usable read", async () => {
    const provider = fakeProvider();
    provider.fetchTransactions.mockRejectedValue(new Error("page missing"));
    await expect(
      new EnableBankingReader(provider).readAccount(
        "owner",
        { applicationId: "test", privateKeyPem: "synthetic" },
        "account",
        { dateFrom: "2026-01-01", dateTo: "2026-01-02" },
      ),
    ).rejects.toThrow("page missing");
    expect(provider.fetchBalance).not.toHaveBeenCalled();
  });
});
