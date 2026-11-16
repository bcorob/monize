import type { SimplefinProvider } from "./simplefin/simplefin.provider";
import type { BankSyncProviderName } from "../bank-sync.constants";
import { BankSyncProviderRegistry } from "./bank-sync-provider.registry";
import type { EnableBankingProvider } from "./enable-banking/enable-banking.client";

describe("BankSyncProviderRegistry", () => {
  const enableBanking = { name: "enable_banking" } as EnableBankingProvider;
  const registry = new BankSyncProviderRegistry(enableBanking);

  it("resolves every named provider", () => {
    for (const name of registry.listNames()) {
      expect(registry.getByName(name).name).toBe(name);
    }
  });

  it("resolves enable_banking to the Enable Banking adapter", () => {
    expect(registry.getByName("enable_banking")).toBe(enableBanking);
  });

  it("throws for a name no provider answers to", () => {
    expect(() => registry.getByName("nope" as BankSyncProviderName)).toThrow(
      'Unknown bank sync provider "nope"',
    );
  });

  it("lists the provider names", () => {
    expect(registry.listNames()).toEqual(["enable_banking"]);
  });
  it("registers SimpleFIN for data reads without fabricating redirect methods", () => {
    const simplefin = { name: "simplefin" } as SimplefinProvider;
    const both = new BankSyncProviderRegistry(enableBanking, simplefin);
    expect(both.listNames()).toEqual(["enable_banking", "simplefin"]);
    expect(both.getReadProvider("simplefin")).toBe(simplefin);
    expect(() => both.getByName("simplefin")).toThrow("setup token");
  });
});
