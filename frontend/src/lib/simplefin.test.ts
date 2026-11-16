import { beforeEach, describe, expect, it, vi } from "vitest";
import apiClient from "./api";
import { simplefinApi } from "./simplefin";
import { clearAllCache, getCached, setCache } from "./apiCache";
vi.mock("./api", () => ({
  default: { get: vi.fn(), post: vi.fn(), delete: vi.fn() },
}));
beforeEach(() => {
  vi.resetAllMocks();
  clearAllCache();
});
describe("SimpleFIN API boundary", () => {
  it("selects SimpleFIN and never consumes the legacy status cache", async () => {
    setCache("bank-sync:status", { provider: "enable_banking" });
    vi.mocked(apiClient.get).mockResolvedValue({
      data: { provider: "simplefin" },
    });
    await simplefinApi.getStatus();
    await simplefinApi.getStatus();
    expect(apiClient.get).toHaveBeenCalledTimes(1);
    expect(apiClient.get).toHaveBeenCalledWith("/bank-sync/status", {
      params: { provider: "simplefin" },
    });
  });
  it("sends the token only in the claim body, once, and refreshes metadata after an ambiguous failure", async () => {
    setCache("bank-sync:connections", ["stale"]);
    setCache("accounts:all:false", ["preserve"]);
    vi.mocked(apiClient.post).mockRejectedValue(new Error("timeout"));
    await expect(simplefinApi.connect("one-use-fixture", true)).rejects.toThrow(
      "timeout",
    );
    expect(apiClient.post).toHaveBeenCalledTimes(1);
    expect(apiClient.post).toHaveBeenCalledWith(
      "/bank-sync/simplefin/connect",
      { setupToken: "one-use-fixture", replaceExisting: true },
      { timeout: 120000 },
    );
    expect(getCached("bank-sync:connections")).toBeUndefined();
    expect(getCached("accounts:all:false")).toEqual(["preserve"]);
  });
  it("retries discovery without sending a token and invalidates metadata", async () => {
    setCache("bank-sync:connections", ["stale"]);
    vi.mocked(apiClient.post).mockResolvedValue({ data: { ok: true } });
    await simplefinApi.discover();
    expect(apiClient.post).toHaveBeenCalledWith(
      "/bank-sync/simplefin/discover",
      undefined,
      { timeout: 60000 },
    );
    expect(getCached("bank-sync:connections")).toBeUndefined();
  });
  it("uses the local credential endpoint and invalidates status even on failure", async () => {
    setCache("bank-sync:simplefin:status", { credentialSet: true });
    vi.mocked(apiClient.delete).mockRejectedValue(new Error("uncertain"));
    await expect(simplefinApi.remove()).rejects.toThrow("uncertain");
    expect(apiClient.delete).toHaveBeenCalledWith(
      "/bank-sync/simplefin/credentials",
    );
    expect(getCached("bank-sync:simplefin:status")).toBeUndefined();
  });
});
