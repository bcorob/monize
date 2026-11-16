import type * as dns from "dns";
import * as http from "http";
import type { AddressInfo, LookupFunction } from "net";
import { Agent, fetch as undiciFetch } from "undici";
import {
  AiEgressRefusedError,
  assertPublicIpLiteral,
  privateTargetAllowed,
  publicOnlyLookupVia,
} from "./provider-egress";
import { providerFetch } from "./long-running-fetch";

type LookupCallback = (
  error: NodeJS.ErrnoException | null,
  address: string | dns.LookupAddress[],
  family?: number,
) => void;

/** What the fake resolver answers for every name, set per test. */
let answer: {
  error: NodeJS.ErrnoException | null;
  addresses: dns.LookupAddress[];
} = { error: null, addresses: [] };

function answerLookupWith(addresses: dns.LookupAddress[]): void {
  answer = { error: null, addresses };
}

/** The production lookup over a resolver the test controls. */
const guardedLookup = publicOnlyLookupVia((_hostname, _options, callback) =>
  callback(answer.error, answer.addresses),
);

/** The same resolver with no guard: what connecting WITHOUT the rule does. */
const unguardedLookup = ((
  _hostname: string,
  options: dns.LookupOptions,
  callback: LookupCallback,
) => {
  const [first] = answer.addresses;
  if (options?.all) callback(null, answer.addresses);
  else callback(null, first.address, first.family);
}) as unknown as LookupFunction;

function runLookup(
  hostname: string,
  options: dns.LookupOptions,
): Promise<{ address: string | dns.LookupAddress[]; family?: number }> {
  return new Promise((resolve, reject) => {
    (
      guardedLookup as unknown as (
        h: string,
        o: dns.LookupOptions,
        cb: LookupCallback,
      ) => void
    )(hostname, options, (error, address, family) => {
      if (error) reject(error);
      else resolve({ address, family });
    });
  });
}

describe("provider-egress", () => {
  const originalAllowlist = process.env.AI_PRIVATE_BASE_URL_ALLOWLIST;

  beforeEach(() => {
    delete process.env.AI_PRIVATE_BASE_URL_ALLOWLIST;
    answer = { error: null, addresses: [] };
  });

  afterAll(() => {
    if (originalAllowlist === undefined) {
      delete process.env.AI_PRIVATE_BASE_URL_ALLOWLIST;
    } else {
      process.env.AI_PRIVATE_BASE_URL_ALLOWLIST = originalAllowlist;
    }
  });

  describe("publicOnlyLookupVia", () => {
    it("answers a public name in the shape the caller asked for", async () => {
      answerLookupWith([{ address: "93.184.216.34", family: 4 }]);
      await expect(runLookup("api.example.test", {})).resolves.toEqual({
        address: "93.184.216.34",
        family: 4,
      });
      await expect(
        runLookup("api.example.test", { all: true }),
      ).resolves.toEqual({
        address: [{ address: "93.184.216.34", family: 4 }],
        family: undefined,
      });
    });

    it.each([
      ["loopback", "127.0.0.1", 4],
      ["RFC1918", "192.168.1.20", 4],
      ["cloud metadata", "169.254.169.254", 4],
      ["IPv6 loopback", "::1", 6],
      ["IPv6 unique-local", "fd00::5", 6],
      ["IPv4-mapped loopback", "::ffff:127.0.0.1", 6],
    ])(
      "refuses a name that resolves to %s (%s)",
      async (_label, address, family) => {
        answerLookupWith([{ address, family }]);
        await expect(
          runLookup("rebind.example.test", {}),
        ).rejects.toBeInstanceOf(AiEgressRefusedError);
      },
    );

    it("refuses when ANY answer is private, not only the first", async () => {
      answerLookupWith([
        { address: "93.184.216.34", family: 4 },
        { address: "10.0.0.1", family: 4 },
      ]);
      await expect(
        runLookup("mixed.example.test", { all: true }),
      ).rejects.toBeInstanceOf(AiEgressRefusedError);
    });

    it("passes a resolver error through unchanged", async () => {
      const failure: NodeJS.ErrnoException = new Error("getaddrinfo ENOTFOUND");
      failure.code = "ENOTFOUND";
      answer = { error: failure, addresses: [] };
      await expect(runLookup("missing.example.test", {})).rejects.toBe(failure);
    });

    it("treats an empty answer as not found", async () => {
      answerLookupWith([]);
      await expect(runLookup("empty.example.test", {})).rejects.toMatchObject({
        code: "ENOTFOUND",
      });
    });
  });

  describe("assertPublicIpLiteral", () => {
    it("refuses a private literal and allows a public one or a name", () => {
      expect(() =>
        assertPublicIpLiteral(new URL("http://[fe80::1]:11434/")),
      ).toThrow(AiEgressRefusedError);
      expect(() =>
        assertPublicIpLiteral(new URL("http://0.0.0.0:11434/")),
      ).toThrow(AiEgressRefusedError);
      expect(() =>
        assertPublicIpLiteral(new URL("https://8.8.8.8/")),
      ).not.toThrow();
      expect(() =>
        assertPublicIpLiteral(new URL("http://ollama.example.test/")),
      ).not.toThrow();
    });
  });

  describe("privateTargetAllowed", () => {
    it("follows the policy, and the allowlist only where the policy reads it", () => {
      process.env.AI_PRIVATE_BASE_URL_ALLOWLIST = "ollama.lan:11434";
      const listed = new URL("http://ollama.lan:11434/api/tags");
      const unlisted = new URL("http://ollama.lan:8080/api/tags");

      expect(privateTargetAllowed(listed, "any")).toBe(true);
      expect(privateTargetAllowed(listed, "public-or-allowlisted")).toBe(true);
      expect(privateTargetAllowed(unlisted, "public-or-allowlisted")).toBe(
        false,
      );
      expect(privateTargetAllowed(listed, "public-only")).toBe(false);
    });
  });

  /**
   * Real sockets on loopback: the refusal is proved where the connection is
   * made, not only where a URL is inspected. A name that resolves to loopback
   * is what DNS rebinding hands a server that validated the URL earlier.
   */
  describe("on a real connection", () => {
    let server: http.Server;
    let port: number;
    let hits: string[];

    beforeAll(async () => {
      server = http.createServer((req, res) => {
        hits.push(req.url ?? "");
        if (req.url === "/redirect") {
          res.writeHead(302, { Location: `http://127.0.0.1:${port}/target` });
          res.end();
          return;
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ internal: "secret" }));
      });
      await new Promise<void>((resolve) =>
        server.listen(0, "127.0.0.1", resolve),
      );
      port = (server.address() as AddressInfo).port;
    });

    beforeEach(() => {
      hits = [];
    });

    afterAll(async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    });

    it("refuses a name that resolves to loopback at connect time (DNS rebinding)", async () => {
      answerLookupWith([{ address: "127.0.0.1", family: 4 }]);
      const agent = new Agent({ connect: { lookup: guardedLookup } });
      try {
        const error = await undiciFetch(
          `http://rebind.example.test:${port}/api/tags`,
          { dispatcher: agent },
        ).catch((e: unknown) => e);

        expect(error).toBeInstanceOf(Error);
        expect((error as Error & { cause?: unknown }).cause).toBeInstanceOf(
          AiEgressRefusedError,
        );
        expect(hits).toEqual([]);
      } finally {
        await agent.close();
      }
    });

    it("reaches that same server through the same name without the guard", async () => {
      answerLookupWith([{ address: "127.0.0.1", family: 4 }]);
      const agent = new Agent({ connect: { lookup: unguardedLookup } });
      try {
        const response = await undiciFetch(
          `http://rebind.example.test:${port}/api/tags`,
          { dispatcher: agent },
        );
        expect(response.status).toBe(200);
        await response.text();
        expect(hits).toEqual(["/api/tags"]);
      } finally {
        await agent.close();
      }
    });

    it("does not follow a redirect", async () => {
      const error = await providerFetch("any")(
        `http://127.0.0.1:${port}/redirect`,
      ).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(Error);
      expect(hits).toEqual(["/redirect"]);
    });

    it("refuses a loopback literal under public-only without connecting", async () => {
      await expect(
        providerFetch("public-only")(`http://127.0.0.1:${port}/api/tags`),
      ).rejects.toBeInstanceOf(AiEgressRefusedError);
      expect(hits).toEqual([]);
    });
  });
});
