import { SimplefinClient } from "./simplefin.client";
import {
  SimplefinTransport,
  SimplefinTransportError,
} from "./simplefin.transport";
import { ProviderHealthService } from "../../../provider-health/provider-health.service";

describe("SimpleFIN provider-health boundary", () => {
  const token = Buffer.from(
    "https://bridge.simplefin.org/simplefin/claim/client-test",
  ).toString("base64");
  const access =
    "https://test-user:test-password@bridge.simplefin.org/simplefin/test";
  const transport: jest.Mocked<Pick<SimplefinTransport, "claim" | "accounts">> =
    {
      claim: jest.fn(),
      accounts: jest.fn(),
    };
  const health: jest.Mocked<
    Pick<
      ProviderHealthService,
      "assertAvailable" | "recordSuccess" | "recordFailure" | "logFailure"
    >
  > = {
    assertAvailable: jest.fn(),
    recordSuccess: jest.fn(),
    recordFailure: jest.fn(),
    logFailure: jest.fn(),
  };
  const client = () =>
    new SimplefinClient(
      transport as unknown as SimplefinTransport,
      health as unknown as ProviderHealthService,
    );
  beforeEach(() => {
    jest.resetAllMocks();
    health.assertAvailable.mockReturnValue("open-gate");
    transport.claim.mockResolvedValue(access);
    transport.accounts.mockResolvedValue({});
  });
  it("gates the request and records a successful answer", async () => {
    await expect(client().claim(token)).resolves.toBe(access);
    expect(health.assertAvailable).toHaveBeenCalledWith("simplefin");
    expect(health.recordSuccess).toHaveBeenCalledWith("simplefin");
  });
  it("does not issue an outbound request when the circuit refuses it", async () => {
    health.assertAvailable.mockImplementation(() => {
      throw new Error("unavailable");
    });
    await expect(client().claim(token)).rejects.toMatchObject({
      kind: "transport",
    });
    expect(transport.claim).not.toHaveBeenCalled();
    expect(health.recordFailure).not.toHaveBeenCalled();
  });
  it.each([401, 402, 403, 429, 500])(
    "treats HTTP %i as reachability, never a global credential outage",
    async (status) => {
      transport.accounts.mockRejectedValue(
        new SimplefinTransportError("http", status),
      );
      await expect(client().accounts(access)).rejects.toMatchObject({ status });
      expect(health.recordSuccess).toHaveBeenCalledWith("simplefin");
      expect(health.recordFailure).not.toHaveBeenCalled();
    },
  );
  it("replaces raw network errors before logging or rethrowing", async () => {
    transport.claim.mockRejectedValue(new Error(access + token));
    await expect(client().claim(token)).rejects.toMatchObject({
      message: "SimpleFIN request failed",
    });
    const error = health.recordFailure.mock.calls[0][1] as Error;
    expect(error.message).toBe("SimpleFIN transport failed");
    expect(JSON.stringify(health.logFailure.mock.calls)).not.toContain(
      "test-password",
    );
    expect(health.logFailure).toHaveBeenCalledTimes(1);
  });
  it("validates the destination before claiming a health probe", async () => {
    await expect(async () => client().claim("invalid")).rejects.toThrow();
    expect(health.assertAvailable).not.toHaveBeenCalled();
  });
  it("distinguishes breaker admission from ambiguous post-dispatch failure", async () => {
    health.assertAvailable.mockImplementationOnce(() => {
      throw new Error("open");
    });
    const first = await client()
      .claim(token)
      .catch((e) => e);
    expect(first.constructor.name).toBe("SimplefinNotDispatchedError");
    expect(transport.claim).not.toHaveBeenCalled();
    await expect(client().claim(token)).resolves.toBe(access);
    transport.claim.mockRejectedValueOnce(new Error("timeout after send"));
    const ambiguous = await client()
      .claim(token)
      .catch((e) => e);
    expect(ambiguous.constructor.name).toBe("SimplefinTransportError");
  });
});
