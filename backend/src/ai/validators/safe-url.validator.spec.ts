import "reflect-metadata";
import { validate } from "class-validator";
import {
  IsSafeUrl,
  IsSafeUrlConstraint,
  IsSafeProviderBaseUrlConstraint,
  validateUrlBasicSafety,
  validateUrlIsSafe,
} from "./safe-url.validator";

// Mock dns module before importing the validator class
jest.mock("dns", () => ({
  resolve4: jest.fn((_hostname, cb) => cb(null, ["93.184.216.34"])),
  resolve6: jest.fn((_hostname, cb) => cb(null, [])),
}));

import * as dns from "dns";

const mockResolve4 = dns.resolve4 as unknown as jest.Mock;
const mockResolve6 = dns.resolve6 as unknown as jest.Mock;

class TestDto {
  @IsSafeUrl()
  baseUrl: string;
}

function buildDto(url: string): TestDto {
  const dto = new TestDto();
  dto.baseUrl = url;
  return dto;
}

async function expectValid(url: string) {
  const errors = await validate(buildDto(url));
  expect(errors).toHaveLength(0);
}

async function expectInvalid(url: string) {
  const errors = await validate(buildDto(url));
  expect(errors.length).toBeGreaterThan(0);
  expect(errors[0].property).toBe("baseUrl");
}

describe("IsSafeUrl validator", () => {
  beforeEach(() => {
    // Default: DNS resolves to a public IP
    mockResolve4.mockImplementation((_h, cb) => cb(null, ["93.184.216.34"]));
    mockResolve6.mockImplementation((_h, cb) => cb(null, []));
  });

  describe("valid external URLs", () => {
    it("accepts https URL", async () => {
      await expectValid("https://api.openai.com/v1");
    });

    it("accepts http URL", async () => {
      await expectValid("http://example.com");
    });

    it("accepts URL with port", async () => {
      await expectValid("https://api.example.com:8080/path");
    });

    it("accepts URL with path and query", async () => {
      await expectValid("https://example.com/api?key=value");
    });

    it("accepts public IP", async () => {
      await expectValid("https://93.184.216.34/api");
    });
  });

  describe("non-string and malformed inputs", () => {
    it("rejects non-string value", async () => {
      const dto = new TestDto();
      (dto as any).baseUrl = 12345;
      const errors = await validate(dto);
      expect(errors.length).toBeGreaterThan(0);
    });

    it("rejects malformed URL", async () => {
      await expectInvalid("not-a-url");
    });

    it("rejects empty string", async () => {
      await expectInvalid("");
    });
  });

  describe("blocked protocols", () => {
    it("rejects ftp://", async () => {
      await expectInvalid("ftp://example.com/file");
    });

    it("rejects file://", async () => {
      await expectInvalid("file:///etc/passwd");
    });

    it("rejects javascript:", async () => {
      await expectInvalid("javascript:alert(1)");
    });
  });

  describe("blocked hostnames", () => {
    it("rejects localhost", async () => {
      await expectInvalid("https://localhost/api");
    });

    it("rejects metadata.google.internal", async () => {
      await expectInvalid("http://metadata.google.internal/computeMetadata");
    });

    it("rejects 169.254.169.254 (AWS metadata)", async () => {
      await expectInvalid("http://169.254.169.254/latest/meta-data");
    });

    it("rejects metadata", async () => {
      await expectInvalid("http://metadata/api");
    });
  });

  describe("blocked suffixes", () => {
    it("rejects .internal suffix", async () => {
      await expectInvalid("https://my-service.internal/api");
    });

    it("rejects .local suffix", async () => {
      await expectInvalid("https://printer.local/status");
    });

    it("rejects .localhost suffix", async () => {
      await expectInvalid("https://app.localhost/api");
    });

    it("rejects bare 'internal' hostname", async () => {
      await expectInvalid("https://internal/api");
    });

    it("rejects bare 'local' hostname", async () => {
      await expectInvalid("https://local/api");
    });
  });

  describe("private IP ranges", () => {
    it("rejects 127.0.0.1 (loopback)", async () => {
      await expectInvalid("https://127.0.0.1/api");
    });

    it("rejects 127.x.x.x range", async () => {
      await expectInvalid("https://127.255.0.1/api");
    });

    it("rejects 10.x.x.x (private class A)", async () => {
      await expectInvalid("https://10.0.0.1/api");
    });

    it("rejects 172.16.x.x (private class B)", async () => {
      await expectInvalid("https://172.16.0.1/api");
    });

    it("rejects 172.31.x.x (private class B upper)", async () => {
      await expectInvalid("https://172.31.255.255/api");
    });

    it("allows 172.15.x.x (not private)", async () => {
      await expectValid("https://172.15.0.1/api");
    });

    it("rejects 192.168.x.x (private class C)", async () => {
      await expectInvalid("https://192.168.1.1/api");
    });

    it("rejects 0.x.x.x", async () => {
      await expectInvalid("https://0.0.0.0/api");
    });

    it("rejects 169.254.x.x (link-local)", async () => {
      await expectInvalid("https://169.254.1.1/api");
    });

    // 100.64.0.0/10 (CGNAT, Tailscale) and 198.18.0.0/15 (benchmarking) are not
    // public hosts; the edges prove the ranges are not wider than their CIDRs.
    it.each([
      "100.64.0.1",
      "100.100.100.100",
      "100.127.255.254",
      "198.18.0.1",
      "198.19.255.255",
    ])("rejects %s (CGNAT / benchmark range)", async (ip) => {
      await expectInvalid(`http://${ip}:8080/v1`);
    });

    it("rejects an IPv4-mapped CGNAT address", async () => {
      await expectInvalid("http://[::ffff:100.100.100.100]:8080/v1");
    });

    it.each(["100.63.255.255", "100.128.0.1", "198.17.0.1", "198.20.0.1"])(
      "still allows %s (outside the blocked ranges)",
      async (ip) => {
        await expectValid(`http://${ip}:8080/v1`);
      },
    );
  });

  // `URL.hostname` keeps the brackets on an IPv6 literal, and every check in the
  // validator compares against unbracketed forms: net.isIP("[::1]") is 0,
  // normalizeIp returns null, and /^::1$/ does not match. So every case below
  // passed the strict check until `unbracketHost` was added -- an SSRF bypass on
  // any client-supplied URL, reachable through one bracket pair.
  describe("IPv6 literals (bracketed-host bypass prevention)", () => {
    it("rejects [::1] (loopback)", async () => {
      await expectInvalid("https://[::1]/api");
    });

    it("rejects [::1] on an explicit port", async () => {
      await expectInvalid("https://[::1]:8080/api");
    });

    it("rejects [::] (unspecified)", async () => {
      await expectInvalid("https://[::]/api");
    });

    it("rejects a unique-local address", async () => {
      await expectInvalid("https://[fd00::1]/api");
    });

    it("rejects a link-local address", async () => {
      await expectInvalid("https://[fe80::1]/api");
    });

    it("rejects an IPv4-mapped loopback", async () => {
      await expectInvalid("https://[::ffff:127.0.0.1]/api");
    });

    it("allows a public IPv6 address", async () => {
      await expectValid("https://[2606:4700:4700::1111]/api");
    });

    // An IPv6 address can embed an IPv4 one in more than one spelling, and the
    // URL parser rewrites all of them to hex -- so a rule written per-spelling
    // covers whichever ones its author thought of. The first pass here handled
    // `::ffff:` with a two-group tail, which left IPv4-compatible and
    // IPv4-translated LOOPBACK accepted: `https://[::127.0.0.1]/` arrives as
    // `::7f00:1` and matched no pattern at all.
    it.each([
      // IPv4-compatible, the deprecated `::a.b.c.d` form.
      ["loopback, IPv4-compatible", "https://[::127.0.0.1]/api"],
      ["private, IPv4-compatible", "https://[::10.0.0.1]/api"],
      ["metadata, IPv4-compatible", "https://[::169.254.169.254]/api"],
      // IPv4-translated, `::ffff:0:a.b.c.d`.
      ["loopback, IPv4-translated", "https://[::ffff:0:127.0.0.1]/api"],
      ["private, IPv4-translated", "https://[::ffff:0:192.168.1.1]/api"],
      // Already-hex spellings, which is what the parser hands the validator.
      ["loopback, written in hex", "https://[::7f00:1]/api"],
      ["mapped loopback in hex", "https://[::ffff:7f00:1]/api"],
      // NAT64: the prefix exists so a gateway forwards it to the embedded
      // address, which is the whole hazard.
      ["private behind the NAT64 prefix", "https://[64:ff9b::10.0.0.1]/api"],
      [
        "loopback behind the local-use NAT64 prefix",
        "https://[64:ff9b:1::127.0.0.1]/api",
      ],
    ])("rejects %s", async (_name, url) => {
      await expectInvalid(url);
    });

    // A CIDR block is a mask over the first 16 bits, and spelling it as a text
    // prefix covered a fraction of what it claimed: `/^fc00:/` plus `/^fd/` left
    // `fc01::1` through `fcff::1` -- most of unique-local fc00::/7 -- reading as
    // public, and `/^fe80:/` left `fe90::` to `febf::` of link-local fe80::/10.
    // Every one of these was accepted as a push endpoint this server then POSTs
    // to on a schedule.
    it.each([
      ["the bottom of fc00::/7", "https://[fc00::1]/api"],
      ["the block the prefix rule missed", "https://[fc01::1]/api"],
      ["the top of the fc half", "https://[fcff:ffff::1]/api"],
      ["the fd half", "https://[fd00::1]/api"],
      ["the top of fc00::/7", "https://[fdff:ffff::1]/api"],
      ["the bottom of fe80::/10", "https://[fe80::1]/api"],
      ["the middle of fe80::/10", "https://[fe90::1]/api"],
      ["the top of fe80::/10", "https://[febf:ffff::1]/api"],
      ["deprecated site-local", "https://[fec0::1]/api"],
      ["link-local all-nodes multicast", "https://[ff02::1]/api"],
    ])("rejects %s", async (_name, url) => {
      await expectInvalid(url);
    });

    // The boundaries from the outside, which is what makes the masks a range
    // rather than a wider ban: fb.. is below fc00::/7 and fe00 is below
    // fe80::/10, and both are ordinary global space.
    it.each([
      ["just below fc00::/7", "https://[fbff:ffff::1]/api"],
      ["just below fe80::/10", "https://[fe00::1]/api"],
      ["documentation space", "https://[2001:db8::1]/api"],
    ])("allows %s", async (_name, url) => {
      await expectValid(url);
    });

    // The other direction, because a check that rejects everything is not a
    // check: an embedded PUBLIC address stays reachable.
    it.each([
      ["a mapped public address", "https://[::ffff:8.8.8.8]/api"],
      ["a public address behind NAT64", "https://[64:ff9b::8.8.8.8]/api"],
      // Not an embedding at all -- an ordinary address whose last 32 bits
      // happen to spell one.
      [
        "an ordinary address with a low-bit tail",
        "https://[2001:db8::7f00:1]/api",
      ],
    ])("allows %s", async (_name, url) => {
      await expectValid(url);
    });
  });

  describe("alternative IP encodings (SSRF bypass prevention)", () => {
    it("rejects decimal IP for 127.0.0.1 (2130706433)", async () => {
      await expectInvalid("https://2130706433/api");
    });

    it("rejects decimal IP for 10.0.0.1 (167772161)", async () => {
      await expectInvalid("https://167772161/api");
    });

    it("rejects hex IP for 127.0.0.1 (0x7f000001)", async () => {
      await expectInvalid("https://0x7f000001/api");
    });

    it("rejects hex IP for 10.0.0.1 (0x0a000001)", async () => {
      await expectInvalid("https://0x0a000001/api");
    });

    it("rejects octal IP for 127.0.0.1 (0177.0.0.1)", async () => {
      await expectInvalid("https://0177.0.0.1/api");
    });
  });

  describe("URLs with credentials", () => {
    it("rejects URL with username", async () => {
      await expectInvalid("https://admin@example.com/api");
    });

    it("rejects URL with username and password", async () => {
      await expectInvalid("https://admin:password@example.com/api");
    });
  });

  describe("DNS resolution blocking", () => {
    it("rejects hostname that resolves to private IP", async () => {
      mockResolve4.mockImplementation((_h, cb) => cb(null, ["127.0.0.1"]));
      await expectInvalid("https://evil.example.com/api");
    });

    it("rejects hostname resolving to 10.x.x.x", async () => {
      mockResolve4.mockImplementation((_h, cb) => cb(null, ["10.0.0.5"]));
      await expectInvalid("https://evil.example.com/api");
    });

    it("rejects hostname resolving to 192.168.x.x", async () => {
      mockResolve4.mockImplementation((_h, cb) => cb(null, ["192.168.1.100"]));
      await expectInvalid("https://evil.example.com/api");
    });

    it("allows hostname resolving to public IP", async () => {
      mockResolve4.mockImplementation((_h, cb) => cb(null, ["93.184.216.34"]));
      await expectValid("https://api.example.com/v1");
    });

    it("allows hostname when DNS resolution fails", async () => {
      mockResolve4.mockImplementation((_h, cb) =>
        cb(new Error("ENOTFOUND"), null),
      );
      mockResolve6.mockImplementation((_h, cb) =>
        cb(new Error("ENOTFOUND"), null),
      );
      await expectValid("https://nonexistent-but-allowed.example.com/api");
    });

    it("rejects when all resolved IPs are private (mixed v4)", async () => {
      mockResolve4.mockImplementation((_h, cb) =>
        cb(null, ["10.0.0.1", "10.0.0.2"]),
      );
      await expectInvalid("https://multi.example.com/api");
    });

    it("rejects when any resolved IP is private (mixed public + private)", async () => {
      mockResolve4.mockImplementation((_h, cb) =>
        cb(null, ["93.184.216.34", "10.0.0.1"]),
      );
      await expectInvalid("https://mixed.example.com/api");
    });

    it("skips DNS check for direct IP addresses", async () => {
      mockResolve4.mockClear();
      await expectValid("https://93.184.216.34/api");
      expect(mockResolve4).not.toHaveBeenCalled();
    });
  });

  describe("default error message", () => {
    it("returns descriptive message", async () => {
      const errors = await validate(buildDto("ftp://evil.com"));
      expect(errors[0].constraints).toBeDefined();
      const message = Object.values(errors[0].constraints!)[0];
      expect(message).toContain("valid HTTP/HTTPS URL");
    });
  });
});

describe("validateUrlIsSafe()", () => {
  beforeEach(() => {
    mockResolve4.mockImplementation((_h, cb) => cb(null, ["93.184.216.34"]));
    mockResolve6.mockImplementation((_h, cb) => cb(null, []));
  });

  it("returns true for a safe public URL", async () => {
    expect(await validateUrlIsSafe("https://api.example.com/v1")).toBe(true);
  });

  it("returns false for a localhost URL", async () => {
    expect(await validateUrlIsSafe("http://localhost/foo")).toBe(false);
  });

  it("returns false for invalid URL strings", async () => {
    expect(await validateUrlIsSafe("not-a-url")).toBe(false);
  });
});

describe("validateUrlBasicSafety()", () => {
  it("returns true for an http URL", () => {
    expect(validateUrlBasicSafety("http://localhost:11434")).toBe(true);
  });

  it("returns true for an https URL", () => {
    expect(validateUrlBasicSafety("https://internal.lan/foo")).toBe(true);
  });

  it("returns false for a non-http(s) protocol", () => {
    expect(validateUrlBasicSafety("ftp://server/foo")).toBe(false);
  });

  it("returns false for malformed URLs", () => {
    expect(validateUrlBasicSafety("not-a-url")).toBe(false);
  });

  it("returns false when credentials are embedded", () => {
    expect(validateUrlBasicSafety("http://user:pw@server/foo")).toBe(false);
  });
});

describe("IsSafeProviderBaseUrlConstraint", () => {
  beforeEach(() => {
    mockResolve4.mockImplementation((_h, cb) => cb(null, ["93.184.216.34"]));
    mockResolve6.mockImplementation((_h, cb) => cb(null, []));
  });

  it("rejects non-string values", async () => {
    const c = new IsSafeProviderBaseUrlConstraint();
    expect(
      await c.validate(123, { object: { provider: "anthropic" } } as any),
    ).toBe(false);
  });

  it("rejects empty string", async () => {
    const c = new IsSafeProviderBaseUrlConstraint();
    expect(
      await c.validate("", { object: { provider: "anthropic" } } as any),
    ).toBe(false);
  });

  it("falls back to basic safety when provider is undefined", async () => {
    const c = new IsSafeProviderBaseUrlConstraint();
    // Basic safety allows localhost URLs
    expect(
      await c.validate("http://localhost:11434", {
        object: {},
      } as any),
    ).toBe(true);
  });

  it("returns false (and updates message) for missing provider with bad URL", async () => {
    const c = new IsSafeProviderBaseUrlConstraint();
    expect(await c.validate("ftp://evil.com", { object: {} } as any)).toBe(
      false,
    );
    expect(c.defaultMessage()).toContain("without embedded credentials");
  });

  it("uses basic safety for self-hosted providers (ollama)", async () => {
    const c = new IsSafeProviderBaseUrlConstraint();
    expect(
      await c.validate("http://localhost:11434", {
        object: { provider: "ollama" },
      } as any),
    ).toBe(true);
  });

  it("rejects bad URL for self-hosted providers", async () => {
    const c = new IsSafeProviderBaseUrlConstraint();
    expect(
      await c.validate("ftp://server", {
        object: { provider: "ollama" },
      } as any),
    ).toBe(false);
  });

  it("uses strict safety for cloud providers", async () => {
    const c = new IsSafeProviderBaseUrlConstraint();
    expect(
      await c.validate("https://api.openai.com/v1", {
        object: { provider: "openai" },
      } as any),
    ).toBe(true);
  });

  it("rejects localhost for cloud providers", async () => {
    const c = new IsSafeProviderBaseUrlConstraint();
    const ok = await c.validate("http://localhost:8080", {
      object: { provider: "openai" },
    } as any);
    expect(ok).toBe(false);
    expect(c.defaultMessage()).toContain("external host");
  });

  // ─── Branch coverage extras ─────────────────────────────────────────

  describe("normalizeIp branches via IsSafeUrlConstraint", () => {
    it("rejects decimal-encoded loopback IP", async () => {
      const c = new IsSafeUrlConstraint();
      // 2130706433 = 127.0.0.1
      expect(await c.validate("http://2130706433/")).toBe(false);
    });

    it("allows decimal-encoded public IP", async () => {
      const c = new IsSafeUrlConstraint();
      // 134744072 = 8.8.8.8
      expect(await c.validate("http://134744072/")).toBe(true);
    });

    it("rejects hex-encoded loopback IP (0x7f000001 = 127.0.0.1)", async () => {
      const c = new IsSafeUrlConstraint();
      expect(await c.validate("http://0x7f000001/")).toBe(false);
    });

    it("allows hex-encoded public IP", async () => {
      const c = new IsSafeUrlConstraint();
      expect(await c.validate("http://0x08080808/")).toBe(true);
    });

    it("rejects octal-dotted loopback IP (0177.0.0.1)", async () => {
      const c = new IsSafeUrlConstraint();
      expect(await c.validate("http://0177.0.0.1/")).toBe(false);
    });

    it("allows octal-dotted public IP", async () => {
      const c = new IsSafeUrlConstraint();
      expect(await c.validate("http://0010.0010.0010.0010/")).toBe(true);
    });

    it("rejects URL with embedded credentials", async () => {
      const c = new IsSafeUrlConstraint();
      expect(await c.validate("http://user:pw@example.com/")).toBe(false);
    });

    it("returns false for non-string input", async () => {
      const c = new IsSafeUrlConstraint();
      expect(await c.validate(undefined as never)).toBe(false);
      expect(await c.validate(123 as never)).toBe(false);
    });

    it("returns false for unparseable URL", async () => {
      const c = new IsSafeUrlConstraint();
      expect(await c.validate("not a url")).toBe(false);
    });

    it("returns false for non-http(s) protocol", async () => {
      const c = new IsSafeUrlConstraint();
      expect(await c.validate("ftp://example.com/")).toBe(false);
    });

    it("rejects 'localhost' hostname (in BLOCKED_HOSTNAMES)", async () => {
      const c = new IsSafeUrlConstraint();
      expect(await c.validate("http://localhost/")).toBe(false);
    });
  });
});
