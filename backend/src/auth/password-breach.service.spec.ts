import { PasswordBreachService } from "./password-breach.service";

describe("PasswordBreachService", () => {
  let service: PasswordBreachService;
  let fetchSpy: jest.SpyInstance;

  beforeEach(() => {
    service = new PasswordBreachService();
    fetchSpy = jest.spyOn(global, "fetch");
    jest
      .spyOn((service as any).logger, "warn")
      .mockImplementation(() => undefined);
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  // SHA-1("password123") is CBFDAC6008F9CAB4083784CBD1874F76618D2A97, so the
  // HIBP range request carries the prefix CBFDA and the service compares the
  // remaining 35 characters against the body. A fixture that recomputed the
  // hash with the same library would only prove the service agrees with
  // itself; a value known independently of the implementation proves the
  // protocol, and keeps password hashing out of the test entirely.
  const PASSWORD123_PREFIX = "CBFDA";
  const PASSWORD123_SUFFIX = "C6008F9CAB4083784CBD1874F76618D2A97";

  it("returns true when password is found in breach data", async () => {
    const responseBody = `${PASSWORD123_SUFFIX}:42\nABCDEF1234567890ABCDEFGHIJKLMNOPQR:5`;

    fetchSpy.mockResolvedValue({
      ok: true,
      text: jest.fn().mockResolvedValue(responseBody),
    });

    const result = await service.isBreached("password123");

    expect(result).toBe(true);
    expect(fetchSpy).toHaveBeenCalledWith(
      `https://api.pwnedpasswords.com/range/${PASSWORD123_PREFIX}`,
      expect.objectContaining({
        headers: { "User-Agent": "Monize-PasswordCheck" },
      }),
    );
  });

  it("returns false when password is not found in breach data", async () => {
    const responseBody =
      "0000000000000000000000000000000AAAA:1\nBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB:2";

    fetchSpy.mockResolvedValue({
      ok: true,
      text: jest.fn().mockResolvedValue(responseBody),
    });

    const result = await service.isBreached("my-unique-secure-password-xyz!");

    expect(result).toBe(false);
  });

  it("fails open when API returns non-OK status", async () => {
    fetchSpy.mockResolvedValue({
      ok: false,
      status: 503,
    });

    const result = await service.isBreached("password123");

    expect(result).toBe(false);
    expect((service as any).logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("HIBP API returned status 503"),
    );
  });

  it("fails open when fetch throws a network error", async () => {
    fetchSpy.mockRejectedValue(new Error("Network error"));

    const result = await service.isBreached("password123");

    expect(result).toBe(false);
    expect((service as any).logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("HIBP API request failed"),
    );
  });
});
