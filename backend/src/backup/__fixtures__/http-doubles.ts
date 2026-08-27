import { EventEmitter } from "events";
import type { IncomingMessage, ServerResponse } from "http";

/**
 * The HTTP doubles the restore upload gate's specs run against.
 *
 * Shared rather than copied because two spec files need them: the budgeting and
 * lifecycle tests, and the authorization tests that arrived with DR-F3RB-003.
 * They are doubles of `http`'s own types, not of our code -- the gate reads a few
 * headers and listens for a few events, and these provide exactly that, so a test
 * asserting on the budget is asserting on the budget rather than on a mock.
 *
 * In `__fixtures__/` so coverage does not count it (see `collectCoverageFrom`).
 */

/**
 * A request carrying only what the middleware reads, plus the `end` event that
 * tells the gate the body has arrived.
 *
 * Method and content-type default to what a real restore upload sends, because
 * the gate budgets exactly what the parser downstream will buffer -- see the
 * "requests the parser will not buffer" block for the other side of that.
 */
export function request(
  headers: Record<string, string | string[]> = {},
  method = "POST",
) {
  const emitter = new EventEmitter();
  const req = Object.assign(emitter, {
    method,
    headers: { "content-type": "application/gzip", ...headers },
    destroyed: false,
    destroy() {
      req.destroyed = true;
    },
  });
  return req as unknown as IncomingMessage & {
    destroyed: boolean;
    emit: (event: string) => boolean;
  };
}

/** The body finished arriving, so the handler now owns it. */
export function bodyArrived(req: unknown) {
  (req as unknown as EventEmitter).emit("end");
}

/**
 * A response that records what was written and can emit `finish`/`close`, which
 * is how a reservation is released. Not a mock of the calls -- the property under
 * test is that the budget goes back down, and only the event does that.
 */
export function response() {
  const emitter = new EventEmitter();
  const headers: Record<string, string> = {};
  const res = Object.assign(emitter, {
    statusCode: 200,
    setHeader(name: string, value: string) {
      headers[name.toLowerCase()] = value;
    },
    end(body?: string) {
      res.body = body;
    },
  }) as EventEmitter & {
    statusCode: number;
    setHeader: (n: string, v: string) => void;
    end: (b?: string) => void;
    body?: string;
  };
  return { res: res as unknown as ServerResponse, raw: res, headers };
}
