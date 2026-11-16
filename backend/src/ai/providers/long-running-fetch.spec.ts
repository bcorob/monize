// Mock undici BEFORE importing the helper, so the helper picks up our mocks.
const mockUndiciFetch = jest.fn();
const mockAgentInstances: Array<{ options: unknown; dispatch: jest.Mock }> = [];

jest.mock("undici", () => {
  return {
    Agent: jest.fn().mockImplementation((options: unknown) => {
      const instance = { options, dispatch: jest.fn() };
      mockAgentInstances.push(instance);
      return instance;
    }),
    fetch: mockUndiciFetch,
  };
});

import {
  longRunningAgent,
  longRunningFetch,
  providerFetch,
  publicOnlyAgent,
} from "./long-running-fetch";
import { AiEgressRefusedError, publicOnlyLookup } from "./provider-egress";

describe("long-running-fetch", () => {
  const originalAllowlist = process.env.AI_PRIVATE_BASE_URL_ALLOWLIST;

  beforeEach(() => {
    mockUndiciFetch.mockReset();
    mockUndiciFetch.mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers(),
    });
    delete process.env.AI_PRIVATE_BASE_URL_ALLOWLIST;
  });

  afterAll(() => {
    if (originalAllowlist === undefined) {
      delete process.env.AI_PRIVATE_BASE_URL_ALLOWLIST;
    } else {
      process.env.AI_PRIVATE_BASE_URL_ALLOWLIST = originalAllowlist;
    }
  });

  describe("longRunningAgent", () => {
    it("is constructed with body and headers timeouts disabled", () => {
      // The Agent mock captured the constructor options at module load time.
      const constructed = mockAgentInstances[0];
      expect(constructed).toBeDefined();
      expect(constructed.options).toEqual({
        bodyTimeout: 0,
        headersTimeout: 0,
      });
    });

    it("is the same instance the helper exports", () => {
      // Sanity check: longRunningAgent is the mocked Agent instance.
      expect(longRunningAgent).toBe(mockAgentInstances[0]);
    });
  });

  describe("publicOnlyAgent", () => {
    it("resolves through the lookup that refuses private answers", () => {
      expect(publicOnlyAgent).toBe(mockAgentInstances[1]);
      expect(mockAgentInstances[1].options).toEqual({
        bodyTimeout: 0,
        headersTimeout: 0,
        connect: { lookup: publicOnlyLookup },
      });
    });
  });

  describe("providerFetch", () => {
    it("never follows a redirect, whatever the caller asked for", async () => {
      await providerFetch("public-only")("https://api.example.test/v1", {
        redirect: "follow",
      });
      const [, init] = mockUndiciFetch.mock.calls[0];
      expect(init.redirect).toBe("error");
    });

    it("sends a public-only request through the guarded dispatcher", async () => {
      await providerFetch("public-only")("https://api.example.test/v1/models");
      const [, init] = mockUndiciFetch.mock.calls[0];
      expect(init.dispatcher).toBe(publicOnlyAgent);
    });

    it.each([
      "http://127.0.0.1:11434/api/tags",
      "http://[::1]:11434/api/tags",
      "http://169.254.169.254/latest/meta-data/",
      "http://2130706433/api/tags",
      "http://10.0.0.5:8080/v1/chat/completions",
    ])("refuses %s before any connection under public-only", async (url) => {
      await expect(providerFetch("public-only")(url)).rejects.toBeInstanceOf(
        AiEgressRefusedError,
      );
      expect(mockUndiciFetch).not.toHaveBeenCalled();
    });

    it("lets the `any` policy reach a private address unrestricted", async () => {
      await providerFetch("any")("http://192.168.1.10:11434/api/tags");
      const [, init] = mockUndiciFetch.mock.calls[0];
      expect(init.dispatcher).toBe(longRunningAgent);
      expect(init.redirect).toBe("error");
    });

    it("reaches only the allowlisted host and port under public-or-allowlisted", async () => {
      process.env.AI_PRIVATE_BASE_URL_ALLOWLIST = "10.0.0.5:11434";
      const guarded = providerFetch("public-or-allowlisted");

      await guarded("http://10.0.0.5:11434/api/tags");
      expect(mockUndiciFetch.mock.calls[0][1].dispatcher).toBe(
        longRunningAgent,
      );

      await expect(
        guarded("http://10.0.0.5:8080/api/tags"),
      ).rejects.toBeInstanceOf(AiEgressRefusedError);

      await guarded("https://ollama.example.test/api/tags");
      expect(mockUndiciFetch.mock.calls[1][1].dispatcher).toBe(publicOnlyAgent);
    });

    it("reads the target from a Request object as well as a string", async () => {
      await expect(
        providerFetch("public-only")(
          new Request("http://127.0.0.1/v1/models") as unknown as string,
        ),
      ).rejects.toBeInstanceOf(AiEgressRefusedError);
    });
  });

  describe("longRunningFetch", () => {
    it("calls undici.fetch (not global fetch) with the long-running dispatcher", async () => {
      await longRunningFetch("https://example.test/api", {
        method: "POST",
        body: JSON.stringify({ ping: true }),
      });

      expect(mockUndiciFetch).toHaveBeenCalledTimes(1);
      const [url, init] = mockUndiciFetch.mock.calls[0];
      expect(url).toBe("https://example.test/api");
      expect(init.method).toBe("POST");
      expect(init.dispatcher).toBe(longRunningAgent);
    });

    it("passes through caller-provided init options", async () => {
      const headers = { "X-Custom": "value" };
      await longRunningFetch("https://example.test/api", {
        method: "GET",
        headers,
      });

      const [, init] = mockUndiciFetch.mock.calls[0];
      expect(init.method).toBe("GET");
      expect(init.headers).toBe(headers);
      expect(init.dispatcher).toBe(longRunningAgent);
    });

    it("works without any caller-provided init", async () => {
      await longRunningFetch("https://example.test/api");

      const [, init] = mockUndiciFetch.mock.calls[0];
      expect(init.dispatcher).toBe(longRunningAgent);
      expect(init.redirect).toBe("error");
    });

    it("does not call globalThis.fetch", async () => {
      // Critical regression: globalThis.fetch (Node's built-in) silently
      // ignores or rejects an Agent instance from a separately-installed
      // undici package. The helper must call undici.fetch directly.
      const globalFetchSpy = jest.fn();
      const originalGlobalFetch = global.fetch;
      global.fetch = globalFetchSpy as unknown as typeof fetch;
      try {
        await longRunningFetch("https://example.test/api");
        expect(globalFetchSpy).not.toHaveBeenCalled();
        expect(mockUndiciFetch).toHaveBeenCalled();
      } finally {
        global.fetch = originalGlobalFetch;
      }
    });

    it("matches the global fetch signature", () => {
      // Compile-time check: longRunningFetch must be assignable to typeof fetch
      const f: typeof fetch = longRunningFetch;
      expect(typeof f).toBe("function");
    });
  });
});
