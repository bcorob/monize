import { Request } from "express";
import { clientIpOf } from "./client-ip.util";

function request(parts: { ip?: string; remoteAddress?: string }): Request {
  return {
    ip: parts.ip,
    socket: parts.remoteAddress ? { remoteAddress: parts.remoteAddress } : {},
  } as unknown as Request;
}

describe("clientIpOf", () => {
  it("prefers what Express resolved, which is the proxy-aware answer", () => {
    // `main.ts` sets `trust proxy` to 1, so `req.ip` is the client behind the
    // one reverse proxy this stack ships with; the socket is the hop itself.
    expect(
      clientIpOf(request({ ip: "203.0.113.7", remoteAddress: "10.0.0.2" })),
    ).toBe("203.0.113.7");
  });

  it("falls back to the socket for a request Express did not resolve", () => {
    expect(clientIpOf(request({ remoteAddress: "198.51.100.9" }))).toBe(
      "198.51.100.9",
    );
  });

  /**
   * The reason this helper exists rather than each call site reading `req.ip`.
   * A dual-stack Node listener reports every IPv4 client as an IPv4-mapped IPv6
   * address, so one machine is `203.0.113.4` on a deployment that binds v4 and
   * `::ffff:203.0.113.4` on one that binds v6 -- two spellings of one address,
   * landing in one column, read by a human trying to tell two endpoints apart.
   */
  it("strips the IPv4-mapped IPv6 prefix, in both source positions", () => {
    expect(clientIpOf(request({ ip: "::ffff:203.0.113.4" }))).toBe(
      "203.0.113.4",
    );
    expect(clientIpOf(request({ remoteAddress: "::ffff:198.51.100.5" }))).toBe(
      "198.51.100.5",
    );
  });

  it("leaves a genuine IPv6 address alone", () => {
    expect(clientIpOf(request({ ip: "2001:db8::1" }))).toBe("2001:db8::1");
  });

  // Unknown is a state, and it has to stay one: a placeholder would put every
  // unresolvable request at one fictitious address.
  it.each([
    ["nothing at all", {}],
    ["an empty ip", { ip: "" }],
    ["whitespace", { ip: "   " }],
  ])("answers null for %s", (_name, parts) => {
    expect(clientIpOf(request(parts))).toBeNull();
  });
});
