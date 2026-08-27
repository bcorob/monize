import type { IncomingMessage, ServerResponse } from "http";
import { PEAK_MULTIPLE } from "./backup-limits";
import { RESTORE_RETRY_AFTER_SECONDS } from "./restore-queue-config";

/**
 * Aggregate admission for restore uploads, in front of the body parser.
 *
 * `resolveRestoreUploadLimitBytes` bounds **one** request. It cannot bound two.
 * `express.raw` buffers the whole body onto the heap before the controller, the
 * JWT guard and the global `ThrottlerGuard` -- those are Nest guards, and they
 * run after parsing -- so two unauthenticated clients each streaming just under
 * the per-request ceiling allocate twice the ceiling on a container sized for
 * one, and the only replica is OOM-killed. Nothing further down the path can
 * refuse an allocation that has already happened.
 *
 * So the process keeps a running total of the bytes it has promised, and a
 * request is admitted only if its own claim still fits.
 *
 * ## The claim is the peak, not the wire
 *
 * The first version reserved the declared `Content-Length` and nothing else, which
 * counted the smallest of the buffers a restore holds. An encrypted 60 MiB upload
 * is the envelope, plus `decipher.update`'s output, plus `Buffer.concat`'s new
 * buffer, plus the decompressed payload, plus the UTF-8 string, plus the parsed
 * object graph -- several of them live at the same moment. Three such uploads
 * declared 180 MiB, fitted a 200 MiB budget, and could pass 540 MiB in flight.
 *
 * So a request claims `PEAK_MULTIPLE` times its wire bytes -- measured at about 8
 * per byte of *expanded* payload (issue #1073), which against wire bytes is still
 * an underestimate whenever the artifact compresses at all. It is an enormous
 * improvement on 1: it makes the budget refuse the several-smaller-uploads case,
 * which is the one the wire-byte version admitted. What actually bounds the
 * decompressed cost is the processing gate, because expansion is capped by the
 * expanded ceiling and not by the compressed length. The honest fix for both is
 * streaming the input through decryption and gzip into a bounded temporary file or
 * an incremental parser, which is a change to the restore pipeline rather than to
 * this gate.
 *
 * ## A reservation is held until the work is done, not until the socket shuts
 *
 * `ServerResponse` emits `close` when the connection ends, which is not the same
 * as the handler finishing. Releasing on `close` let a client upload a full body,
 * let the controller enter `restoreData`, then hang up -- freeing the whole
 * reservation while the decryption, the staging and the SQL were still running and
 * still holding their buffers. A second large upload was then admitted beside the
 * first, which is exactly the situation this gate exists to prevent, reachable by
 * disconnect timing.
 *
 * So the reservation has a lifecycle:
 *
 * - **receiving** -- the body is still arriving. A `close` here means the client
 *   went away before anything downstream took ownership, so releasing is right.
 * - **processing** -- the body has been read, so the handler owns it. Only the
 *   handler saying it is finished (`releaseRestoreReservation`, from a `finally`)
 *   or the response completing (`finish`) releases it. A `close` is ignored.
 *
 * A request that never reaches the route -- rejected by a guard, a 404 -- still
 * gets a response, so `finish` covers it.
 *
 * ## Authorization runs before the reservation (DR-F3RB-003)
 *
 * Authentication cannot move earlier -- Nest's guards run after parsing -- so
 * authorization moved here instead. `authorize` is handed a request before a single
 * byte is promised, and on refusal nothing is reserved: an unauthenticated client
 * can no longer occupy the restore budget at all. The check it performs is one HMAC
 * over a short-lived ticket minted by an ordinary authenticated route
 * (`restore-upload-ticket.ts`), deliberately synchronous and allocation-free -- a
 * database round trip in front of the body parser would be a new lever for the load
 * this gate exists to refuse.
 *
 * `receiveTimeoutMs` still bounds how long an *authorized* caller may hold its
 * claim without sending a body: a stalled upload from a real user is possible
 * whether or not they meant it. What remains unaddressed is the memory shape
 * itself -- streaming the input through decryption and gzip into a bounded
 * temporary file or an incremental parser, which is what would replace
 * `PEAK_MULTIPLE` with a real bound rather than a measured one. See
 * `docs/backup-restore-contract.md`.
 */
export interface RestoreUploadAdmission {
  /** Express middleware: admits, or answers 503/413/408 itself. */
  middleware: (
    req: IncomingMessage,
    res: ServerResponse,
    next: (error?: unknown) => void,
  ) => void;
  /** Bytes currently promised. Exposed for tests and diagnostics. */
  reservedBytes: () => number;
}

/**
 * How long a body may take to arrive before its reservation is reclaimed.
 *
 * Only ever counted while receiving, never while the handler is working -- a
 * timeout on processing would be the release-too-early defect with a delay.
 */
export const DEFAULT_RECEIVE_TIMEOUT_MS = 120_000;

/**
 * The content types `express.raw` is configured to buffer on the restore route.
 *
 * The gate budgets exactly what the parser allocates, and nothing else. A CORS
 * preflight carries no `Content-Length`, so without this it would claim the whole
 * ceiling for a request that buffers nothing -- turning the protection into a way
 * to deny the upload it protects.
 */
const PARSED_CONTENT_TYPES = ["application/gzip", "application/octet-stream"];

/** Where the handler's release hook is stashed for the controller to find. */
const RESERVATION = Symbol("monize.restoreUploadReservation");

/**
 * Releases the admission reservation for this request, if it holds one.
 *
 * Called from the restore handler's `finally`, which is the only place that knows
 * the expensive work is over. Idempotent, and a no-op on a request that was never
 * admitted (a unit test, another route), so a caller never has to check.
 */
export function releaseRestoreReservation(req: unknown): void {
  const holder = req as Record<symbol, unknown> | null;
  const release = holder?.[RESERVATION];
  if (typeof release === "function") (release as () => void)();
}

/** Whether the parser downstream will actually buffer this request's body. */
function willBuffer(req: IncomingMessage): boolean {
  const method = (req.method ?? "").toUpperCase();
  if (method !== "POST" && method !== "PUT" && method !== "PATCH") return false;
  const contentType = req.headers["content-type"];
  if (typeof contentType !== "string") return false;
  // "application/gzip; charset=..." is the same type; compare the media type only.
  const mediaType = contentType.split(";")[0].trim().toLowerCase();
  return PARSED_CONTENT_TYPES.includes(mediaType);
}

/** Parses `Content-Length`, returning null when absent or unusable. */
function contentLengthOf(req: IncomingMessage): number | null {
  const raw = req.headers["content-length"];
  if (typeof raw !== "string") return null;
  // A repeated header arrives as "10,10"; anything but a single integer is not a
  // length this can budget from, so it falls back to the conservative claim.
  if (!/^\d+$/.test(raw.trim())) return null;
  const parsed = Number(raw.trim());
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

/**
 * Decides whether this request may be budgeted for at all, before it is.
 *
 * Synchronous by contract: it runs in front of the body parser, so anything it
 * awaits is work an unauthenticated caller can make the process do. Omitted, the
 * gate admits anyone -- which is what it did before DR-F3RB-003, and what unit
 * tests of the budgeting itself still want.
 */
export type RestoreUploadAuthorizer = (
  req: IncomingMessage,
) => { ok: true } | { ok: false; status: number; message: string };

export function createRestoreUploadAdmission(
  perRequestLimitBytes: number,
  budgetBytes: number = perRequestLimitBytes * PEAK_MULTIPLE,
  onRefusal?: (message: string) => void,
  receiveTimeoutMs: number = DEFAULT_RECEIVE_TIMEOUT_MS,
  authorize?: RestoreUploadAuthorizer,
): RestoreUploadAdmission {
  let reserved = 0;

  const refuse = (
    res: ServerResponse,
    status: number,
    message: string,
    retryAfterSeconds?: number,
  ) => {
    onRefusal?.(message);
    res.statusCode = status;
    res.setHeader("Content-Type", "application/json");
    if (retryAfterSeconds !== undefined) {
      res.setHeader("Retry-After", String(retryAfterSeconds));
    }
    res.end(JSON.stringify({ statusCode: status, message }));
  };

  return {
    reservedBytes: () => reserved,
    middleware: (req, res, next) => {
      // Nothing to budget for a request the parser will not buffer.
      if (!willBuffer(req)) {
        next();
        return;
      }

      // Before anything is promised. A refusal here reserves nothing, which is the
      // whole point: an unauthenticated request must not be able to occupy the
      // budget even for the receive deadline (DR-F3RB-003).
      const permitted = authorize?.(req) ?? { ok: true as const };
      if (!permitted.ok) {
        refuse(res, permitted.status, permitted.message);
        return;
      }

      // A ceiling of zero is the derivation saying this container has no room for
      // any restore. Falling through would answer 413 "exceeds the restore size
      // limit" for every upload, naming no lever and reading as "your file is too
      // big" when the truth is that no file would fit -- and the startup log and
      // the processing gate both promise a 503 that names what to change. No
      // Retry-After: retrying an unchanged deployment cannot help.
      if (perRequestLimitBytes <= 0) {
        refuse(
          res,
          503,
          "This deployment has no memory headroom for a restore: one restore's " +
            "modeled peak does not fit the container. Raise the container memory " +
            "limit or lower BACKUP_RESTORE_EXPANDED_LIMIT.",
        );
        return;
      }

      const declared = contentLengthOf(req);

      if (declared !== null && declared > perRequestLimitBytes) {
        // Refused before reserving: promising memory for a body that is already
        // over the ceiling would let a rejected request occupy the budget.
        refuse(
          res,
          413,
          "Backup upload exceeds the restore size limit for this deployment.",
        );
        return;
      }

      // No length means no promise from the client, so budget for the most it
      // could send. Then multiplied, because the wire bytes are the smallest of
      // the buffers this request will hold.
      const claim = (declared ?? perRequestLimitBytes) * PEAK_MULTIPLE;

      if (reserved + claim > budgetBytes) {
        refuse(
          res,
          503,
          "Another restore is in progress. Retry in a moment.",
          RESTORE_RETRY_AFTER_SECONDS,
        );
        return;
      }

      reserved += claim;
      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        reserved -= claim;
        clearTimeout(receiveDeadline);
      };

      // The handler's hook. It is what turns "the socket closed" into "the work
      // is over" -- the two are not the same, and treating them as the same is
      // what let a disconnect free memory the restore was still using.
      (req as unknown as Record<symbol, unknown>)[RESERVATION] = release;

      // While the body is still arriving, a lost connection means nothing
      // downstream ever took ownership, so releasing is correct. Once it has
      // arrived, only the handler or a completed response may release.
      let receiving = true;
      const bodyArrived = () => {
        receiving = false;
        clearTimeout(receiveDeadline);
      };
      req.once("end", bodyArrived);

      // A body that never arrives would otherwise hold its claim until the socket
      // died, which on a trickling unauthenticated client is indefinitely. Only
      // armed while receiving; a slow *restore* is not a stalled upload.
      const receiveDeadline = setTimeout(() => {
        if (!receiving) return;
        refuse(
          res,
          408,
          "Backup upload timed out before the body arrived.",
          RESTORE_RETRY_AFTER_SECONDS,
        );
        release();
        req.destroy();
      }, receiveTimeoutMs);
      // Do not hold the event loop open on this timer.
      receiveDeadline.unref?.();

      res.once("finish", release);
      res.once("close", () => {
        // Only while receiving. Afterwards the handler owns the body and may
        // still be decrypting, staging or writing it.
        if (receiving) release();
      });

      next();
    },
  };
}
