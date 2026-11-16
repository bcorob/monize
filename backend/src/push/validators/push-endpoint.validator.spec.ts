import "reflect-metadata";
import { validate } from "class-validator";

// Mocked before the validator is imported, so no spec here reaches real DNS.
jest.mock("dns", () => ({
  resolve4: jest.fn((_hostname, cb) => cb(null, ["93.184.216.34"])),
  resolve6: jest.fn((_hostname, cb) => cb(null, [])),
}));

import {
  IsPushEndpoint,
  IsPushEndpointConstraint,
  MAX_PUSH_ENDPOINT_LENGTH,
} from "./push-endpoint.validator";
import { URL_SAFETY_CHECK_TIMEOUT_MS } from "../../ai/validators/safe-url.validator";

class TestDto {
  @IsPushEndpoint()
  endpoint: string;
}

async function errorsFor(endpoint: string) {
  const dto = new TestDto();
  dto.endpoint = endpoint;
  return validate(dto);
}

describe("IsPushEndpoint", () => {
  const constraint = new IsPushEndpointConstraint();

  it.each([
    "https://updates.push.services.mozilla.com/wpush/v2/abcdef",
    "https://fcm.googleapis.com/fcm/send/abcdef:APA91b",
    "https://web.push.apple.com/QAbc123",
  ])("accepts the real push services (%s)", async (endpoint) => {
    await expect(constraint.validate(endpoint)).resolves.toBe(true);
    await expect(errorsFor(endpoint)).resolves.toHaveLength(0);
  });

  // The one rule this validator adds over the shared SSRF check. A push endpoint
  // is issued by Mozilla, Google or Apple and is always https; plain http is a
  // forged value, not a permissive deployment.
  it.each([
    "http://updates.push.services.mozilla.com/wpush/v2/abcdef",
    "ftp://example.com/x",
    "file:///etc/passwd",
    "javascript:alert(1)",
  ])("rejects a non-https scheme (%s)", async (endpoint) => {
    await expect(constraint.validate(endpoint)).resolves.toBe(false);
  });

  // Inherited from validateUrlIsSafe, and asserted here because this is the
  // field a client controls: the comment thread on discussion #1291 named the
  // SSRF surface before any alternative transport exists.
  it.each([
    "https://127.0.0.1/wpush",
    "https://localhost/wpush",
    "https://10.0.0.5/wpush",
    "https://192.168.1.10/wpush",
    "https://172.16.0.1/wpush",
    "https://169.254.169.254/latest/meta-data",
    "https://metadata.google.internal/computeMetadata",
    "https://postgres.internal/wpush",
    "https://[::1]/wpush",
    "https://0x7f000001/wpush",
    "https://2130706433/wpush",
  ])("rejects a private or internal destination (%s)", async (endpoint) => {
    await expect(constraint.validate(endpoint)).resolves.toBe(false);
  });

  it("rejects an endpoint carrying embedded credentials", async () => {
    await expect(
      constraint.validate("https://user:pass@fcm.googleapis.com/fcm/send/x"),
    ).resolves.toBe(false);
  });

  it("rejects a host that resolves to a private address (DNS rebinding)", async () => {
    const dns = jest.requireMock("dns");
    dns.resolve4.mockImplementationOnce(
      (_hostname: string, cb: (e: null, a: string[]) => void) =>
        cb(null, ["10.1.2.3"]),
    );

    await expect(
      constraint.validate("https://push.attacker.example/wpush"),
    ).resolves.toBe(false);
  });

  // The endpoint is a host the CALLER names, and the safety check resolves it.
  // `dns.resolve4`/`resolve6` carry no timeout, so an unbounded check would hold
  // this request for the resolver's whole retry budget -- before returning the
  // 400 it was always going to return -- twenty times a minute per account.
  it("gives up on a resolver that never answers rather than holding the request", async () => {
    const dns = jest.requireMock("dns");
    dns.resolve4.mockImplementationOnce(() => undefined);
    dns.resolve6.mockImplementationOnce(() => undefined);

    jest.useFakeTimers();
    try {
      const pending = constraint.validate(
        "https://blackhole.attacker.example/wpush",
      );
      await jest.advanceTimersByTimeAsync(URL_SAFETY_CHECK_TIMEOUT_MS + 1);

      // It settles, and it settles as a refusal: not knowing whether a host is
      // public is not the same as knowing it is.
      await expect(pending).resolves.toBe(false);
    } finally {
      jest.useRealTimers();
    }
  });

  it("rejects an endpoint longer than the column can hold", async () => {
    const tooLong = `https://fcm.googleapis.com/fcm/send/${"a".repeat(MAX_PUSH_ENDPOINT_LENGTH)}`;

    expect(tooLong.length).toBeGreaterThan(MAX_PUSH_ENDPOINT_LENGTH);
    await expect(constraint.validate(tooLong)).resolves.toBe(false);
  });

  it.each([undefined, null, 42, {}, [], ""])(
    "rejects a non-string or empty value (%p)",
    async (value) => {
      await expect(constraint.validate(value)).resolves.toBe(false);
    },
  );

  it("says what is wrong in terms of the field the client sent", () => {
    // The shared IsSafeUrl message names `baseUrl`, which no push client has.
    expect(constraint.defaultMessage()).toContain("endpoint");
    expect(constraint.defaultMessage()).not.toContain("baseUrl");
  });
});
