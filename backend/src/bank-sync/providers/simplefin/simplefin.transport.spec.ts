import * as https from "node:https";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { IncomingMessage, ClientRequest } from "node:http";
import { simplefinLookup } from "./simplefin.lookup";
import {
  SimplefinTransport,
  SIMPLEFIN_RESPONSE_LIMIT,
  SIMPLEFIN_REQUEST_DEADLINE_MS,
} from "./simplefin.transport";

const access =
  "https://secret-user:secret-password@bridge.simplefin.org/simplefin";
const setup = Buffer.from(
  "https://bridge.simplefin.org/simplefin/claim/secret-token",
).toString("base64");

function harness() {
  const response = new PassThrough() as PassThrough & IncomingMessage;
  response.statusCode = 200;
  response.headers = {};
  Object.defineProperty(response, "complete", { value: true, writable: true });
  const request = new EventEmitter() as EventEmitter & ClientRequest;
  request.destroy = jest.fn().mockReturnValue(request);
  request.end = jest.fn().mockImplementation(() => {
    queueMicrotask(() => callback(response));
    return request;
  });
  let callback: (response: IncomingMessage) => void;
  const send = jest.fn().mockImplementation((_url, _options, cb) => {
    callback = cb;
    return request;
  });
  return {
    transport: new SimplefinTransport(send as unknown as typeof https.request),
    response,
    request,
    send,
  };
}

describe("SimpleFIN bounded HTTPS transport", () => {
  it("pins the public-only lookup and keeps credentials out of the request URL", async () => {
    const h = harness();
    const result = h.transport.accounts(access);
    await Promise.resolve();
    h.response.end('{"accounts":[]}');
    await expect(result).resolves.toEqual({ accounts: [] });
    const [url, options] = h.send.mock.calls[0];
    expect(url.username).toBe("");
    expect(url.password).toBe("");
    expect(url.searchParams.get("version")).toBe("2");
    expect(url.searchParams.get("balances-only")).toBe("1");
    expect(options).toMatchObject({
      agent: false,
      lookup: simplefinLookup,
      servername: "bridge.simplefin.org",
      rejectUnauthorized: true,
      headers: {
        "Accept-Encoding": "identity",
        Authorization: expect.stringMatching(/^Basic /),
      },
    });
  });

  it("claims once with POST, validates the resulting Access URL", async () => {
    const h = harness();
    const result = h.transport.claim(setup);
    await Promise.resolve();
    h.response.end(access);
    await expect(result).resolves.toBe(access);
    expect(h.send).toHaveBeenCalledTimes(1);
    expect(h.send.mock.calls[0][1].method).toBe("POST");
    expect(h.send.mock.calls[0][1].headers.Authorization).toBeUndefined();
  });

  it("sends bounded epoch windows and omits balances-only for transaction requests", async () => {
    const h = harness();
    const result = h.transport.accounts(access, {
      startDate: 1,
      endDate: 86401,
    });
    await Promise.resolve();
    h.response.end("{}");
    await result;
    const url = h.send.mock.calls[0][0] as URL;
    expect(url.searchParams.get("start-date")).toBe("1");
    expect(url.searchParams.get("end-date")).toBe("86401");
    expect(url.searchParams.has("balances-only")).toBe(false);
  });

  it.each([301, 302, 307, 308, 401, 402, 403, 429, 500])(
    "refuses HTTP %i without following or replaying the request",
    async (status) => {
      const h = harness();
      h.response.statusCode = status;
      h.response.headers.location = access;
      const result = h.transport.claim(setup);
      await expect(result).rejects.toMatchObject({
        status,
        message: "SimpleFIN request failed",
      });
      expect(h.send).toHaveBeenCalledTimes(1);
      expect(h.request.destroy).toHaveBeenCalled();
    },
  );

  it("never includes underlying transport secrets in an error", async () => {
    const h = harness();
    const result = h.transport.accounts(access);
    h.request.emit("error", new Error(access + setup));
    await expect(result).rejects.toMatchObject({
      kind: "transport",
      message: "SimpleFIN request failed",
    });
  });

  it("refuses compressed bodies instead of decoding an unbounded payload", async () => {
    const h = harness();
    h.response.headers["content-encoding"] = "gzip";
    await expect(h.transport.accounts(access)).rejects.toMatchObject({
      kind: "encoding",
    });
  });

  it("stops reading once the body exceeds 10 MiB", async () => {
    const h = harness();
    const result = h.transport.accounts(access);
    await Promise.resolve();
    h.response.write(Buffer.alloc(SIMPLEFIN_RESPONSE_LIMIT + 1));
    await expect(result).rejects.toMatchObject({ kind: "oversized" });
    expect(h.response.destroyed).toBe(true);
  });

  it("refuses truncated bodies", async () => {
    const h = harness();
    Object.defineProperty(h.response, "complete", { value: false });
    const result = h.transport.accounts(access);
    await Promise.resolve();
    h.response.end("{}");
    await expect(result).rejects.toMatchObject({ kind: "transport" });
  });

  it("bounds a stalled body with the total request deadline", async () => {
    jest.useFakeTimers();
    try {
      const h = harness();
      const result = h.transport.accounts(access);
      const assertion = expect(result).rejects.toMatchObject({
        kind: "transport",
      });
      await jest.advanceTimersByTimeAsync(SIMPLEFIN_REQUEST_DEADLINE_MS);
      await assertion;
      expect(h.request.destroy).toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });

  it.each(["not JSON", ""])("refuses malformed Account Sets", async (body) => {
    const h = harness();
    const result = h.transport.accounts(access);
    await Promise.resolve();
    h.response.end(body);
    await expect(result).rejects.toMatchObject({ kind: "invalid_response" });
  });

  it("refuses a claim response pointing outside the supported Bridge hosts", async () => {
    const h = harness();
    const result = h.transport.claim(setup);
    await Promise.resolve();
    h.response.end("https://user:password@localhost/simplefin");
    await expect(result).rejects.toMatchObject({ kind: "invalid_response" });
  });

  it("rejects an oversized date window before making a request", async () => {
    const h = harness();
    await expect(
      h.transport.accounts(access, { startDate: 0, endDate: 91 * 86400 }),
    ).rejects.toMatchObject({ kind: "invalid_response" });
    expect(h.send).not.toHaveBeenCalled();
  });
});
