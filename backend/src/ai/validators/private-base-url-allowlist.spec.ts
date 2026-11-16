import {
  isAllowlistedPrivateBaseUrl,
  privateBaseUrlAllowlist,
} from "./private-base-url-allowlist";

describe("privateBaseUrlAllowlist", () => {
  it("is empty when unset or blank", () => {
    expect(privateBaseUrlAllowlist(undefined)).toEqual({
      entries: [],
      invalid: [],
    });
    expect(privateBaseUrlAllowlist("  ")).toEqual({
      entries: [],
      invalid: [],
    });
  });

  it("reads hosts, host:port pairs and bracketed IPv6", () => {
    expect(
      privateBaseUrlAllowlist(
        " Ollama.LAN , 192.168.1.20:11434, [FD00::1]:8000,[::1]",
      ).entries,
    ).toEqual([
      { host: "ollama.lan", port: null },
      { host: "192.168.1.20", port: 11434 },
      { host: "fd00::1", port: 8000 },
      { host: "::1", port: null },
    ]);
  });

  it.each([
    "http://ollama.lan",
    "ollama.lan/api",
    "user@ollama.lan",
    "*.lan",
    "10.0.0.0/8",
    "ollama.lan:0",
    "ollama.lan:70000",
    "fd00::1:8000",
  ])("reports %s as unreadable and allows nothing for it", (entry) => {
    const allowlist = privateBaseUrlAllowlist(entry);
    expect(allowlist.entries).toEqual([]);
    expect(allowlist.invalid).toEqual([entry]);
  });
});

describe("isAllowlistedPrivateBaseUrl", () => {
  const allowlist = privateBaseUrlAllowlist(
    "ollama.lan, 192.168.1.20:11434, [fd00::1]:8000",
  );

  it.each([
    ["http://ollama.lan:11434", true],
    ["https://OLLAMA.lan/v1", true],
    ["http://192.168.1.20:11434/api/tags", true],
    ["http://192.168.1.20:8080", false],
    // The scheme's default port is the port compared.
    ["http://192.168.1.20", false],
    ["http://[fd00::1]:8000/v1", true],
    ["http://[fd00::1]:8001/v1", false],
    ["http://192.168.1.21:11434", false],
    ["http://user:pw@ollama.lan", false],
    ["ftp://ollama.lan", false],
    ["not a url", false],
  ])("%s -> %s", (url, expected) => {
    expect(isAllowlistedPrivateBaseUrl(url, allowlist)).toBe(expected);
  });

  it("matches an entry port against the scheme default", () => {
    const withDefault = privateBaseUrlAllowlist("ollama.lan:80");
    expect(isAllowlistedPrivateBaseUrl("http://ollama.lan/", withDefault)).toBe(
      true,
    );
    expect(
      isAllowlistedPrivateBaseUrl("https://ollama.lan/", withDefault),
    ).toBe(false);
  });

  it("reads AI_PRIVATE_BASE_URL_ALLOWLIST when no list is passed", () => {
    const original = process.env.AI_PRIVATE_BASE_URL_ALLOWLIST;
    try {
      process.env.AI_PRIVATE_BASE_URL_ALLOWLIST = "10.1.2.3";
      expect(isAllowlistedPrivateBaseUrl("http://10.1.2.3:11434")).toBe(true);
      delete process.env.AI_PRIVATE_BASE_URL_ALLOWLIST;
      expect(isAllowlistedPrivateBaseUrl("http://10.1.2.3:11434")).toBe(false);
    } finally {
      if (original === undefined) {
        delete process.env.AI_PRIVATE_BASE_URL_ALLOWLIST;
      } else {
        process.env.AI_PRIVATE_BASE_URL_ALLOWLIST = original;
      }
    }
  });
});
