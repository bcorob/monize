jest.mock("../ai/validators/safe-url.validator", () => ({
  validateUrlIsSafeWithin: jest.fn().mockResolvedValue(false),
}));
import {
  privatePushEndpoint,
  privatePushEndpoints,
  pinnedPushLookup,
} from "./unifiedpush-private-endpoints";
import { IsPushEndpointConstraint } from "./validators/push-endpoint.validator";
import { ValidationArguments } from "class-validator";

const config = JSON.stringify({ "https://ntfy.home.lan:8443": "192.168.20.5" });
describe("operator-pinned private UnifiedPush", () => {
  const original = process.env.UNIFIEDPUSH_PRIVATE_ENDPOINTS;
  beforeEach(() => {
    process.env.UNIFIEDPUSH_PRIVATE_ENDPOINTS = config;
  });
  afterEach(() => {
    if (original === undefined)
      delete process.env.UNIFIEDPUSH_PRIVATE_ENDPOINTS;
    else process.env.UNIFIEDPUSH_PRIVATE_ENDPOINTS = original;
  });
  it("defaults to no private exceptions", () =>
    expect(privatePushEndpoints("").size).toBe(0));
  it("matches only an exact HTTPS origin and explicit UnifiedPush transport", () => {
    const endpoint = "https://ntfy.home.lan:8443/topic?up=1";
    expect(privatePushEndpoint(endpoint, "unifiedpush")?.address).toBe(
      "192.168.20.5",
    );
    for (const transport of [undefined, "webpush", "other"])
      expect(privatePushEndpoint(endpoint, transport)).toBeUndefined();
    for (const url of [
      "https://ntfy.home.lan/topic",
      "https://sub.ntfy.home.lan:8443/topic",
      "https://ntfy.home.lan.evil.test:8443/topic",
      "http://ntfy.home.lan:8443/topic",
      "https://user:pass@ntfy.home.lan:8443/topic",
      "https://ntfy.home.lan:8443/topic#fragment",
      "bad-url",
    ])
      expect(privatePushEndpoint(url, "unifiedpush")).toBeUndefined();
  });
  it.each([
    "127.0.0.1",
    "169.254.169.254",
    "0.0.0.0",
    "100.63.255.255",
    "100.128.0.1",
    "198.17.255.255",
    "198.20.0.1",
    "8.8.8.8",
    "::1",
    "fe80::1",
    "ff02::1",
    "::ffff:169.254.169.254",
    "::ffff:192.168.20.5",
  ])("refuses privileged/non-private destination %s", (address) => {
    expect(() =>
      privatePushEndpoints(
        JSON.stringify({ "https://ntfy.home.lan": address }),
      ),
    ).toThrow(/Invalid UNIFIEDPUSH_PRIVATE_ENDPOINTS/);
  });
  it.each([
    "10.2.3.4",
    "172.16.1.1",
    "192.168.1.1",
    "100.64.0.1",
    "100.127.255.254",
    "198.18.0.1",
    "198.19.255.254",
    "fd12:3456::1",
  ])("accepts private destination %s", (address) => {
    expect(
      privatePushEndpoints(JSON.stringify({ "https://ntfy.home.lan": address }))
        .size,
    ).toBe(1);
  });
  it.each([
    "http://ntfy.home.lan",
    "https://*.home.lan",
    "https://ntfy.home.lan/path",
    "https://ntfy.home.lan?q=1",
    "https://192.168.1.1",
    "https://[fd00::1]",
  ])("rejects ambiguous origin %s", (name) => {
    expect(() =>
      privatePushEndpoints(JSON.stringify({ [name]: "192.168.1.1" })),
    ).toThrow();
  });
  it("rejects malformed or duplicate normalized configuration", () => {
    for (const raw of [
      "[1]",
      "null",
      "{",
      JSON.stringify({
        "https://ntfy.home.lan": "192.168.1.1",
        "https://ntfy.home.lan:443/": "192.168.1.2",
      }),
    ])
      expect(() => privatePushEndpoints(raw)).toThrow();
  });
  it("registration validator uses the DTO transport", async () => {
    const args = {
      object: { transport: "unifiedpush" },
    } as ValidationArguments;
    expect(
      await new IsPushEndpointConstraint().validate(
        "https://ntfy.home.lan:8443/topic",
        args,
      ),
    ).toBe(true);
  });
  it("does not grant browser registration the private exception", async () => {
    const validator = new IsPushEndpointConstraint();
    for (const transport of [undefined, "webpush", "other"]) {
      expect(
        await validator.validate("https://ntfy.home.lan:8443/topic", {
          object: { transport },
        } as ValidationArguments),
      ).toBe(false);
    }
  });

  it("pins both Node lookup callback shapes and rejects a different hostname", () => {
    const pin = privatePushEndpoint(
      "https://ntfy.home.lan:8443/topic",
      "unifiedpush",
    )!;
    const lookup = pinnedPushLookup(pin) as any;
    const one = jest.fn(),
      all = jest.fn(),
      wrong = jest.fn();
    lookup("ntfy.home.lan", {}, one);
    lookup("ntfy.home.lan", { all: true }, all);
    lookup("evil.test", {}, wrong);
    expect(one).toHaveBeenCalledWith(null, "192.168.20.5", 4);
    expect(all).toHaveBeenCalledWith(null, [
      { address: "192.168.20.5", family: 4 },
    ]);
    expect(wrong.mock.calls[0][0]).toBeInstanceOf(Error);
  });
});
