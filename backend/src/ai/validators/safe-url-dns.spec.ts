import * as dns from "dns";

jest.mock("dns", () => ({
  resolve4: jest.fn(),
  resolve6: jest.fn(),
}));

import {
  URL_SAFETY_CHECK_TIMEOUT_MS,
  validateUrlIsSafe,
  validateUrlIsSafeWithin,
} from "./safe-url.validator";

type Callback = (err: Error | null, addresses?: string[]) => void;

const resolve4 = dns.resolve4 as unknown as jest.Mock;
const resolve6 = dns.resolve6 as unknown as jest.Mock;

/** Answer both lookups; either list may be empty. */
function answers(ipv4: string[], ipv6: string[]): void {
  resolve4.mockImplementation((_host: string, cb: Callback) => cb(null, ipv4));
  resolve6.mockImplementation((_host: string, cb: Callback) => cb(null, ipv6));
}

/**
 * The two halves of the safety check that only a controlled resolver can reach:
 * what a NAME resolves to, and what happens when the resolver never answers.
 *
 * `dns.resolve4`/`resolve6` take a callback and carry no timeout of their own,
 * so both properties are invisible to a spec that lets the real resolver run --
 * and the timeout half is what turned a save into a request held open for the
 * whole c-ares retry budget.
 */
describe("the safety check against a controlled resolver", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    answers([], []);
  });

  describe("what the name resolves to", () => {
    it("rejects a name whose A record is private (DNS rebinding)", async () => {
      answers(["10.0.0.5"], []);

      await expect(validateUrlIsSafe("https://rebind.test/x")).resolves.toBe(
        false,
      );
    });

    // The IPv6 half of the same bypass. A resolver answers in hex, so an
    // embedded-IPv4 loopback arrives as `::7f00:1` -- which reaches
    // `isPrivateIp` directly and never passes through the hostname's own
    // normalization. Mapping only at the hostname left this accepted.
    it.each([
      ["an IPv4-compatible loopback", "::7f00:1"],
      ["a mapped loopback", "::ffff:7f00:1"],
      ["a translated private address", "::ffff:0:c0a8:1"],
      ["a unique-local address", "fd00::1"],
      ["plain loopback", "::1"],
    ])("rejects a name whose AAAA record is %s", async (_name, address) => {
      answers([], [address]);

      await expect(validateUrlIsSafe("https://rebind.test/x")).resolves.toBe(
        false,
      );
    });

    it("allows a name that resolves publicly on both families", async () => {
      answers(["93.184.216.34"], ["2606:4700::1111"]);

      await expect(validateUrlIsSafe("https://example.test/x")).resolves.toBe(
        true,
      );
    });
  });

  describe("a resolver that never answers", () => {
    /** Neither callback is ever invoked, which is what a black hole looks like. */
    function neverAnswers(): void {
      resolve4.mockImplementation(() => undefined);
      resolve6.mockImplementation(() => undefined);
    }

    it("is not established as safe, so the check answers false", async () => {
      neverAnswers();

      await expect(
        validateUrlIsSafeWithin("https://blackhole.test/x", 20),
      ).resolves.toBe(false);
    });

    // The bound is inside the check, so a caller that asks for nothing gets it:
    // the AI provider `baseUrl` validators and the startup check all go through
    // `validateUrlIsSafe`, and only the push paths ever passed a timeout.
    it("bounds the plain check too, without the caller asking", async () => {
      neverAnswers();
      jest.useFakeTimers();
      try {
        const pending = validateUrlIsSafe("https://blackhole.test/x");
        await jest.advanceTimersByTimeAsync(URL_SAFETY_CHECK_TIMEOUT_MS + 1);

        await expect(pending).resolves.toBe(false);
      } finally {
        jest.useRealTimers();
      }
    });

    // A lookup that did not answer is not a lookup that answered "nothing":
    // an empty result is allowed (a name that resolves nowhere fails on its own),
    // so a timeout borrowing that answer would be an open door.
    it("does not read a timeout as an empty result", async () => {
      answers([], []);

      await expect(validateUrlIsSafe("https://nowhere.test/x")).resolves.toBe(
        true,
      );
    });

    it("bounds by default at the documented timeout", () => {
      // Five seconds: a save can wait, and bounding the lookup turned a slow
      // resolver into a rejection that names the URL rather than the resolver.
      // The push sender's per-send re-check passes its own tighter bound, since
      // that one is spent once per device inside a fan-out.
      expect(URL_SAFETY_CHECK_TIMEOUT_MS).toBe(5_000);
    });
  });

  // A safe URL must not be delayed by the bound, and a check that answers
  // before the timer is the ordinary case.
  it("returns the check's own answer when it finishes in time", async () => {
    answers(["93.184.216.34"], []);

    await expect(
      validateUrlIsSafeWithin("https://example.test/x", 5_000),
    ).resolves.toBe(true);
  });
});
