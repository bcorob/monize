import { createHmac, timingSafeEqual } from "crypto";
import type { IncomingMessage } from "http";

/**
 * A short-lived, authenticated ticket that must accompany a restore upload
 * (DR-F3RB-003, issue #1073).
 *
 * The upload admission gate has to run in front of `express.raw`, because that is
 * what allocates the body -- and in front of the body parser means in front of
 * Nest's guards, so the gate necessarily budgets memory for requests it cannot
 * authenticate. Until now the only bound on that was time: an unauthenticated
 * client could hold part of the restore budget until the receive deadline expired,
 * degrading a legitimate restore to a retry during exactly the incident a restore
 * is for.
 *
 * Authentication cannot move later, so authorization moves earlier. A caller first
 * asks an ordinary authenticated JSON route (`POST /backup/restore/ticket`, behind
 * the JWT guard, CSRF and the throttler) for a ticket, and the admission middleware
 * verifies it **before reserving anything**. A request with no ticket is refused
 * having claimed no memory at all.
 *
 * **The refusal is 403, not 401**, and the difference is not pedantry: the caller's
 * session is present and valid -- it is this *request* that carries no upload
 * authorization. A 401 would also be read by the client's interceptor as an expired
 * session, which retries the original request after refreshing the token: a silent
 * re-upload of the whole artifact, and a logout mid-restore if the refresh fails.
 * A status is part of the contract with the client, not just a number.
 *
 * ## Signed, not stored
 *
 * The ticket is an HMAC over `{userId, expiry}` rather than a database row, and
 * that is a deliberate trade:
 *
 * - **It works on every replica.** A row would work too, but an in-memory set --
 *   the version that needs no migration -- would not: the ticket is minted on the
 *   pod that served the JSON request and the upload can land on another, so the
 *   restore path would fail on exactly the multi-replica deployments it matters on.
 * - **It costs nothing on the pre-parse path.** Verification is one HMAC, so the
 *   middleware stays synchronous and allocation-free. A database round trip in
 *   front of the body parser would be a new lever for the load it exists to refuse.
 * - **It is not single-use.** A stored ticket could be consumed by a conditional
 *   `UPDATE`; this one can be replayed until it expires. What that buys an attacker
 *   is bounded: the ticket authorizes *occupying upload budget*, not restoring
 *   anything -- the restore itself still needs the caller's JWT, the CSRF pair, and
 *   for an OIDC account a single-use re-authentication artifact. And whoever holds
 *   a ticket held a session cookie a moment ago, which could mint another. The TTL
 *   is what bounds it.
 *
 * The signing key is derived from `JWT_SECRET` with a domain separator, so a ticket
 * can never be confused with (or forged from) an access token, and rotating
 * `JWT_SECRET` invalidates outstanding tickets -- which is the correct behaviour for
 * a five-minute credential.
 */

/** Domain separator: this key signs tickets and nothing else. */
const KEY_CONTEXT = "monize.restore-upload-ticket.v1";

/** The header the upload carries its ticket in. */
export const RESTORE_TICKET_HEADER = "x-restore-upload-ticket";

/**
 * How long a ticket is valid for, in milliseconds.
 *
 * Long enough to cover a user picking a file, a password prompt and the start of a
 * slow upload; short enough that a leaked ticket is worth little. Only the *start*
 * of the upload is checked against it -- a 20-minute transfer that began inside the
 * window is fine, because the ticket is verified once, before the body is read.
 */
export const RESTORE_TICKET_TTL_MS = 5 * 60_000;

/** Why a ticket was rejected. Distinguished for the log, not for the client. */
export type TicketRejection =
  | "missing"
  | "malformed"
  | "bad-signature"
  | "expired";

export interface TicketPayload {
  userId: string;
  expiresAt: number;
}

const base64url = (value: Buffer): string =>
  value
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

const fromBase64url = (value: string): Buffer =>
  Buffer.from(value.replace(/-/g, "+").replace(/_/g, "/"), "base64");

/** The signing key, derived so a ticket is not interchangeable with a JWT. */
function ticketKey(jwtSecret: string): Buffer {
  return createHmac("sha256", jwtSecret).update(KEY_CONTEXT).digest();
}

function sign(payload: string, jwtSecret: string): string {
  return base64url(
    createHmac("sha256", ticketKey(jwtSecret)).update(payload).digest(),
  );
}

/**
 * Mint a ticket for `userId`. Called from an authenticated route, never from the
 * middleware -- the middleware only ever verifies.
 */
export function mintRestoreUploadTicket(
  userId: string,
  jwtSecret: string,
  now: number = Date.now(),
  ttlMs: number = RESTORE_TICKET_TTL_MS,
): { ticket: string; expiresAt: number; expiresInSeconds: number } {
  const expiresAt = now + ttlMs;
  const payload = base64url(
    Buffer.from(JSON.stringify({ userId, expiresAt }), "utf-8"),
  );
  return {
    ticket: `${payload}.${sign(payload, jwtSecret)}`,
    expiresAt,
    expiresInSeconds: Math.floor(ttlMs / 1000),
  };
}

/**
 * Verify a ticket. Returns the payload it carries, or why it was refused.
 *
 * The signature is compared with `timingSafeEqual` on equal-length buffers, and the
 * expiry is only read **after** the signature holds -- reading an attacker-supplied
 * expiry first would be trusting the half of the token that is not yet authentic.
 */
export function verifyRestoreUploadTicket(
  token: string | undefined,
  jwtSecret: string,
  now: number = Date.now(),
):
  | { ok: true; payload: TicketPayload }
  | { ok: false; reason: TicketRejection } {
  if (typeof token !== "string" || token.trim() === "") {
    return { ok: false, reason: "missing" };
  }
  const parts = token.trim().split(".");
  if (parts.length !== 2 || parts[0] === "" || parts[1] === "") {
    return { ok: false, reason: "malformed" };
  }
  const [payload, signature] = parts;

  const expected = Buffer.from(sign(payload, jwtSecret), "utf-8");
  const supplied = Buffer.from(signature, "utf-8");
  // `timingSafeEqual` throws on a length mismatch, which is itself an answer.
  if (
    expected.length !== supplied.length ||
    !timingSafeEqual(expected, supplied)
  ) {
    return { ok: false, reason: "bad-signature" };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(fromBase64url(payload).toString("utf-8"));
  } catch {
    return { ok: false, reason: "malformed" };
  }
  const claim = parsed as { userId?: unknown; expiresAt?: unknown };
  if (
    typeof claim.userId !== "string" ||
    claim.userId === "" ||
    typeof claim.expiresAt !== "number" ||
    !Number.isFinite(claim.expiresAt)
  ) {
    return { ok: false, reason: "malformed" };
  }
  if (claim.expiresAt <= now) return { ok: false, reason: "expired" };
  return {
    ok: true,
    payload: { userId: claim.userId, expiresAt: claim.expiresAt },
  };
}

/**
 * The admission gate's authorization hook: verify the ticket on this request.
 *
 * Built in `main.ts` from `JWT_SECRET` and handed to
 * `createRestoreUploadAdmission`. Kept here rather than inline there so the header
 * name, the failure statuses and the wording live beside the token they describe.
 *
 * A deployment with no `JWT_SECRET` cannot have authenticated anyone, so there is
 * nothing to verify against; startup already refuses to run without one, and this
 * returns a refusal rather than silently admitting.
 */
export function createRestoreTicketAuthorizer(
  jwtSecret: string | undefined,
): (
  req: IncomingMessage,
) => { ok: true } | { ok: false; status: number; message: string } {
  return (req) => {
    if (!jwtSecret) {
      return {
        ok: false,
        status: 503,
        message: "This deployment cannot verify restore uploads.",
      };
    }
    const header = req.headers[RESTORE_TICKET_HEADER];
    const token = Array.isArray(header) ? header[0] : header;
    const result = verifyRestoreUploadTicket(token, jwtSecret);
    if (result.ok) return { ok: true };
    // One message for every rejection: which half of the ticket failed is the
    // operator's business, not the caller's, and the client's remedy is the same
    // either way -- ask for a new ticket.
    return {
      ok: false,
      // 403 rather than 401: the session is fine, this request is not authorized.
      // See the note at the top of this file -- a 401 makes the client retry the
      // whole upload after a token refresh, or log the user out mid-restore.
      status: 403,
      message:
        "A restore upload needs a current upload ticket. Request one from " +
        "POST /api/v1/backup/restore/ticket and retry.",
    };
  };
}
