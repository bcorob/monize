import * as https from "node:https";
import type { IncomingMessage } from "node:http";
import { simplefinLookup } from "./simplefin.lookup";
import { simplefinAccessRequest, simplefinClaimUrl } from "./simplefin.urls";

export const SIMPLEFIN_REQUEST_DEADLINE_MS = 30_000;
export const SIMPLEFIN_RESPONSE_LIMIT = 10 * 1024 * 1024;

export type SimplefinTransportFailure =
  | "transport"
  | "redirect"
  | "http"
  | "encoding"
  | "oversized"
  | "invalid_response";

/** Internal boundary error: never carries provider text, URLs, headers or causes. */
export class SimplefinTransportError extends Error {
  constructor(
    readonly kind: SimplefinTransportFailure,
    readonly status?: number,
  ) {
    super("SimpleFIN request failed");
    this.name = "SimplefinTransportError";
  }
}

/**
 * One attempt only. Callers must durably reserve quota / claim ownership before
 * calling this boundary; it never retries or follows a Location header.
 */
export class SimplefinTransport {
  constructor(private readonly send: typeof https.request = https.request) {}

  async claim(setupToken: string): Promise<string> {
    const body = await this.request(simplefinClaimUrl(setupToken), "POST");
    const accessUrl = body.trim();
    try {
      simplefinAccessRequest(accessUrl);
    } catch {
      throw new SimplefinTransportError("invalid_response");
    }
    return accessUrl;
  }

  async accounts(
    accessUrl: string,
    window?: { startDate: number; endDate: number },
  ): Promise<unknown> {
    const { root, authorization } = simplefinAccessRequest(accessUrl);
    root.pathname += "/accounts";
    root.searchParams.set("version", "2");
    if (window) {
      if (
        !Number.isSafeInteger(window.startDate) ||
        !Number.isSafeInteger(window.endDate) ||
        window.startDate < 0 ||
        window.endDate <= window.startDate ||
        window.endDate - window.startDate > 90 * 86400
      ) {
        throw new SimplefinTransportError("invalid_response");
      }
      root.searchParams.set("start-date", String(window.startDate));
      root.searchParams.set("end-date", String(window.endDate));
    } else {
      root.searchParams.set("balances-only", "1");
    }
    const body = await this.request(root, "GET", authorization);
    try {
      return JSON.parse(body) as unknown;
    } catch {
      throw new SimplefinTransportError("invalid_response");
    }
  }

  private request(
    url: URL,
    method: "GET" | "POST",
    authorization?: string,
  ): Promise<string> {
    return new Promise((resolve, reject) => {
      let settled = false;
      let response: IncomingMessage | undefined;
      let request: ReturnType<typeof https.request> | undefined;
      const finish = (error?: SimplefinTransportError, body?: string) => {
        if (settled) return;
        settled = true;
        clearTimeout(deadline);
        if (error) {
          response?.destroy();
          request?.destroy();
          reject(error);
        } else {
          resolve(body ?? "");
        }
      };
      // The total deadline includes DNS, TLS, headers and body, even a stalled body.
      const deadline = setTimeout(
        () => finish(new SimplefinTransportError("transport")),
        SIMPLEFIN_REQUEST_DEADLINE_MS,
      );
      try {
        request = this.send(
          url,
          {
            method,
            agent: false,
            lookup: simplefinLookup,
            servername: url.hostname,
            rejectUnauthorized: true,
            headers: {
              "User-Agent": "Monize-SimpleFIN/1.0",
              Accept: method === "GET" ? "application/json" : "text/plain",
              // No decompression ambiguity: encoded responses fail closed.
              "Accept-Encoding": "identity",
              ...(authorization ? { Authorization: authorization } : {}),
            },
          },
          (incoming) => {
            response = incoming;
            if (settled) {
              incoming.destroy();
              return;
            }
            incoming.on("error", () =>
              finish(new SimplefinTransportError("transport")),
            );
            incoming.on("aborted", () =>
              finish(new SimplefinTransportError("transport")),
            );
            const status = incoming.statusCode ?? 0;
            if (status >= 300 && status < 400) {
              finish(new SimplefinTransportError("redirect", status));
              return;
            }
            if (status < 200 || status >= 300) {
              finish(new SimplefinTransportError("http", status));
              return;
            }
            const encoding = incoming.headers["content-encoding"];
            if (encoding && encoding !== "identity") {
              finish(new SimplefinTransportError("encoding"));
              return;
            }
            const chunks: Buffer[] = [];
            let size = 0;
            incoming.on("data", (chunk: Buffer) => {
              if (settled) return;
              size += chunk.length;
              if (size > SIMPLEFIN_RESPONSE_LIMIT) {
                finish(new SimplefinTransportError("oversized"));
                return;
              }
              chunks.push(chunk);
            });
            incoming.on("end", () => {
              if (!incoming.complete) {
                finish(new SimplefinTransportError("transport"));
                return;
              }
              finish(undefined, Buffer.concat(chunks).toString("utf8"));
            });
          },
        );
        request.on("error", () =>
          finish(new SimplefinTransportError("transport")),
        );
        request.end();
      } catch {
        finish(new SimplefinTransportError("transport"));
      }
    });
  }
}
