import * as fs from "fs";
import * as path from "path";
import type { IncomingMessage } from "http";
import {
  PEAK_MULTIPLE,
  resolveRestoreUploadLimitBytes,
  restoreProcessBaselineBytes,
} from "./backup-limits";
import {
  DEFAULT_RECEIVE_TIMEOUT_MS,
  createRestoreUploadAdmission,
  releaseRestoreReservation,
} from "./restore-upload-admission";
import { bodyArrived, request, response } from "./__fixtures__/http-doubles";

const MIB = 1024 * 1024;

describe("restore upload admission", () => {
  const LIMIT = 200 * MIB;

  it("admits an upload that fits the budget", () => {
    const admission = createRestoreUploadAdmission(LIMIT);
    const next = jest.fn();
    const { res, raw } = response();

    admission.middleware(
      request({ "content-length": String(150 * MIB) }),
      res,
      next,
    );

    expect(next).toHaveBeenCalledTimes(1);
    expect(raw.statusCode).toBe(200);
    expect(admission.reservedBytes()).toBe(150 * MIB * PEAK_MULTIPLE);
  });

  /**
   * The defect this exists for (F3RRR-002). `express.raw` buffers before the JWT
   * guard and the throttler, so the per-request ceiling -- half the container --
   * is enforced twice over by two concurrent clients and the only replica is
   * OOM-killed. A refused request is the outcome; a dead process is not.
   */
  it("refuses a second concurrent upload the container cannot hold", () => {
    const admission = createRestoreUploadAdmission(LIMIT);
    const first = response();
    const second = response();
    const firstNext = jest.fn();
    const secondNext = jest.fn();

    admission.middleware(
      request({ "content-length": String(190 * MIB) }),
      first.res,
      firstNext,
    );
    admission.middleware(
      request({ "content-length": String(190 * MIB) }),
      second.res,
      secondNext,
    );

    expect(firstNext).toHaveBeenCalledTimes(1);
    expect(secondNext).not.toHaveBeenCalled();
    expect(second.raw.statusCode).toBe(503);
    // Told when to come back rather than left to guess -- this is a transient
    // refusal, unlike the 413.
    expect(second.headers["retry-after"]).toBe("30");
    expect(String(second.raw.body)).toContain("in progress");
  });

  it("admits the next upload once the first response finishes", () => {
    const admission = createRestoreUploadAdmission(LIMIT);
    const first = response();
    admission.middleware(
      request({ "content-length": String(190 * MIB) }),
      first.res,
      jest.fn(),
    );

    first.raw.emit("finish");
    expect(admission.reservedBytes()).toBe(0);

    const second = response();
    const secondNext = jest.fn();
    admission.middleware(
      request({ "content-length": String(190 * MIB) }),
      second.res,
      secondNext,
    );
    expect(secondNext).toHaveBeenCalledTimes(1);
  });

  it("releases the reservation when the client disconnects mid-upload", () => {
    // A dropped connection emits `close` without `finish`. A reservation nothing
    // releases makes the budget shrink to zero over the process's lifetime, which
    // is a self-inflicted outage rather than a protection.
    const admission = createRestoreUploadAdmission(LIMIT);
    const { res, raw } = response();
    admission.middleware(
      request({ "content-length": String(100 * MIB) }),
      res,
      jest.fn(),
    );

    raw.emit("close");
    expect(admission.reservedBytes()).toBe(0);
  });

  it("releases once when both events fire", () => {
    const admission = createRestoreUploadAdmission(LIMIT);
    const { res, raw } = response();
    admission.middleware(
      request({ "content-length": String(100 * MIB) }),
      res,
      jest.fn(),
    );

    raw.emit("finish");
    raw.emit("close");
    // Not -100 MiB: a double release would let the budget grow past the
    // container, which is worse than not having one.
    expect(admission.reservedBytes()).toBe(0);
  });

  it("reserves the whole ceiling when the length is not declared", () => {
    // Chunked encoding does not say how much is coming, and the safe assumption
    // on a path reached before authentication is the most it is allowed to send.
    const admission = createRestoreUploadAdmission(LIMIT);
    const next = jest.fn();
    admission.middleware(request(), response().res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(admission.reservedBytes()).toBe(LIMIT * PEAK_MULTIPLE);

    const second = response();
    const secondNext = jest.fn();
    admission.middleware(request(), second.res, secondNext);
    expect(secondNext).not.toHaveBeenCalled();
    expect(second.raw.statusCode).toBe(503);
  });

  it.each([
    ["a repeated header", "100,100"],
    ["a non-integer", "12.5"],
    ["a negative value", "-1"],
    ["something that is not a number", "lots"],
  ])("reserves the whole ceiling for %s", (_label, value) => {
    // Anything that is not a single non-negative integer is not a length this can
    // budget from, so it takes the conservative claim rather than a parse guess.
    const admission = createRestoreUploadAdmission(LIMIT);
    admission.middleware(
      request({ "content-length": value }),
      response().res,
      jest.fn(),
    );
    expect(admission.reservedBytes()).toBe(LIMIT * PEAK_MULTIPLE);
  });

  it("refuses an over-large declared length without reserving for it", () => {
    const admission = createRestoreUploadAdmission(LIMIT);
    const next = jest.fn();
    const { res, raw, headers } = response();

    admission.middleware(
      request({ "content-length": String(LIMIT + 1) }),
      res,
      next,
    );

    expect(next).not.toHaveBeenCalled();
    expect(raw.statusCode).toBe(413);
    // `express.raw` would refuse this too, but only after this had promised
    // memory on its behalf -- a rejected request must not occupy the budget.
    expect(admission.reservedBytes()).toBe(0);
    // Permanent for this body: retrying the same upload unchanged cannot work,
    // so there is no Retry-After to offer.
    expect(headers).not.toHaveProperty("retry-after");
  });

  it("keeps admitting after a refusal", () => {
    const admission = createRestoreUploadAdmission(LIMIT);
    admission.middleware(
      request({ "content-length": String(LIMIT + 1) }),
      response().res,
      jest.fn(),
    );

    const next = jest.fn();
    admission.middleware(
      request({ "content-length": String(10 * MIB) }),
      response().res,
      next,
    );
    expect(next).toHaveBeenCalledTimes(1);
  });

  it("reports a refusal so an operator can see the pressure", () => {
    const onRefusal = jest.fn();
    const admission = createRestoreUploadAdmission(
      LIMIT,
      LIMIT * PEAK_MULTIPLE,
      onRefusal,
    );
    admission.middleware(request(), response().res, jest.fn());
    admission.middleware(request(), response().res, jest.fn());

    expect(onRefusal).toHaveBeenCalledTimes(1);
    expect(String(onRefusal.mock.calls[0][0])).toContain("in progress");
  });

  it("admits several small uploads at once", () => {
    // The gate is a byte budget, not a mutex: three 10 MiB restores are not the
    // problem, and refusing them would make the fix worse than the defect.
    const admission = createRestoreUploadAdmission(LIMIT);
    for (let i = 0; i < 3; i += 1) {
      const next = jest.fn();
      admission.middleware(
        request({ "content-length": String(10 * MIB) }),
        response().res,
        next,
      );
      expect(next).toHaveBeenCalledTimes(1);
    }
    expect(admission.reservedBytes()).toBe(30 * MIB * PEAK_MULTIPLE);
  });

  /**
   * The gate must budget exactly what the parser allocates. A CORS preflight
   * carries no `Content-Length`, so without this it would claim the whole ceiling
   * for a request that buffers nothing -- turning the protection into a way to
   * deny the upload it protects.
   */
  describe("requests the parser will not buffer", () => {
    it.each([
      ["an OPTIONS preflight", "OPTIONS", "application/gzip"],
      ["a GET", "GET", "application/gzip"],
      ["a JSON POST", "POST", "application/json"],
    ])("passes %s through without reserving", (_label, method, contentType) => {
      const admission = createRestoreUploadAdmission(LIMIT);
      const next = jest.fn();
      admission.middleware(
        request({ "content-type": contentType }, method),
        response().res,
        next,
      );

      expect(next).toHaveBeenCalledTimes(1);
      expect(admission.reservedBytes()).toBe(0);
    });

    it("passes a request with no content-type through", () => {
      const admission = createRestoreUploadAdmission(LIMIT);
      const next = jest.fn();
      admission.middleware(
        { method: "POST", headers: {} } as unknown as IncomingMessage,
        response().res,
        next,
      );

      expect(next).toHaveBeenCalledTimes(1);
      expect(admission.reservedBytes()).toBe(0);
    });

    it("still reserves when the type carries parameters", () => {
      // "application/gzip; charset=binary" is the same media type, and a client
      // that adds a parameter must not slip past the budget.
      const admission = createRestoreUploadAdmission(LIMIT);
      admission.middleware(
        request({ "content-type": "application/gzip; charset=binary" }),
        response().res,
        jest.fn(),
      );
      expect(admission.reservedBytes()).toBe(LIMIT * PEAK_MULTIPLE);
    });

    it("reserves for the encrypted envelope's type too", () => {
      // Encrypted backups upload as application/octet-stream, and the parser
      // buffers both -- a gate that covered only gzip would leave the larger of
      // the two paths unbudgeted.
      const admission = createRestoreUploadAdmission(LIMIT);
      admission.middleware(
        request({
          "content-type": "application/octet-stream",
          "content-length": String(50 * MIB),
        }),
        response().res,
        jest.fn(),
      );
      expect(admission.reservedBytes()).toBe(50 * MIB * PEAK_MULTIPLE);
    });

    it("covers every type the parser is configured with (source guard)", () => {
      // The two lists are in different files, and a new accepted content type
      // added to main.ts without adding it here would be buffered unbudgeted.
      const main = fs.readFileSync(
        path.join(__dirname, "..", "main.ts"),
        "utf8",
      );
      const gate = fs.readFileSync(
        path.join(__dirname, "restore-upload-admission.ts"),
        "utf8",
      );
      const parserTypes =
        /express\.raw\(\{[\s\S]*?type:\s*\[([^\]]*)\]/.exec(main)?.[1] ?? "";
      const types = [...parserTypes.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
      expect(types.length).toBeGreaterThan(0);
      for (const type of types) {
        expect(gate).toContain(`"${type}"`);
      }
    });
  });

  it("accepts a budget larger than one request", () => {
    // An operator with headroom can allow concurrency explicitly rather than
    // being held to one upload by a number they cannot reach.
    const admission = createRestoreUploadAdmission(
      LIMIT,
      2 * LIMIT * PEAK_MULTIPLE,
    );
    const firstNext = jest.fn();
    const secondNext = jest.fn();
    admission.middleware(
      request({ "content-length": String(190 * MIB) }),
      response().res,
      firstNext,
    );
    admission.middleware(
      request({ "content-length": String(190 * MIB) }),
      response().res,
      secondNext,
    );
    expect(firstNext).toHaveBeenCalledTimes(1);
    expect(secondNext).toHaveBeenCalledTimes(1);
  });
});

/**
 * The reservation's lifecycle (F3R5-003).
 *
 * `ServerResponse` emits `close` when the connection ends, which is not the same
 * as the handler finishing. Releasing on `close` let a client upload a full body,
 * let the controller enter `restoreData`, then hang up -- freeing the whole
 * reservation while the decryption, the staging and the SQL were still running
 * and still holding their buffers. A second large upload was then admitted beside
 * the first, which is the situation the gate exists to prevent, reachable by
 * disconnect timing.
 */
/**
 * A container with no headroom derives a ceiling of zero, and the deployment then
 * cannot restore anything at all. That is a real state (a 128 MiB pod), and the
 * startup log, the processing gate and the contract all promise the same answer for
 * it: a 503 naming the two levers. Falling through to the size check answered 413
 * "exceeds the restore size limit" instead -- true in the letter, useless in
 * practice, and reading as "your file is too big" when no file would fit.
 */
describe("restore upload admission on a container with no headroom", () => {
  it("refuses with the lever, not with a size complaint", () => {
    const admission = createRestoreUploadAdmission(0, 0);
    const next = jest.fn();
    const { res, raw, headers } = response();

    admission.middleware(request({ "content-length": "1024" }), res, next);

    expect(next).not.toHaveBeenCalled();
    expect(raw.statusCode).toBe(503);
    expect(raw.body).toMatch(/BACKUP_RESTORE_EXPANDED_LIMIT/);
    expect(raw.body).toMatch(/container memory/i);
    // No Retry-After: nothing about waiting changes this one.
    expect(headers["retry-after"]).toBeUndefined();
    expect(admission.reservedBytes()).toBe(0);
  });

  it("refuses a chunked upload the same way", () => {
    // No Content-Length means no declared size to compare, so this is the path
    // that would otherwise have claimed `perRequestLimitBytes * PEAK_MULTIPLE`
    // -- which is zero, and would have been admitted.
    const admission = createRestoreUploadAdmission(0, 0);
    const next = jest.fn();
    const { res, raw } = response();

    admission.middleware(request(), res, next);

    expect(next).not.toHaveBeenCalled();
    expect(raw.statusCode).toBe(503);
  });
});

describe("restore upload admission lifecycle", () => {
  const LIMIT = 200 * MIB;

  /** Admit a request and hand back the pieces the assertions need. */
  function admit(
    admission: ReturnType<typeof createRestoreUploadAdmission>,
    lengthMib = 190,
  ) {
    const req = request({ "content-length": String(lengthMib * MIB) });
    const res = response();
    const next = jest.fn();
    admission.middleware(req, res.res, next);
    return { req, res, next };
  }

  it("keeps the reservation when the client disconnects after the body arrived", () => {
    const admission = createRestoreUploadAdmission(LIMIT);
    const first = admit(admission);
    expect(first.next).toHaveBeenCalledTimes(1);

    // The parser finished reading; the handler owns the body from here.
    bodyArrived(first.req);
    first.res.raw.emit("close");

    // Still held: decryption, staging and SQL are all still to come, and they
    // hold the buffers this budget is about.
    expect(admission.reservedBytes()).toBe(190 * MIB * PEAK_MULTIPLE);

    const second = admit(admission);
    expect(second.next).not.toHaveBeenCalled();
    expect(second.res.raw.statusCode).toBe(503);
  });

  it("releases when the handler says the work is over", () => {
    const admission = createRestoreUploadAdmission(LIMIT);
    const { req, res } = admit(admission);
    bodyArrived(req);
    res.raw.emit("close");
    expect(admission.reservedBytes()).toBeGreaterThan(0);

    // What the controller's `finally` calls.
    releaseRestoreReservation(req);
    expect(admission.reservedBytes()).toBe(0);

    const second = admit(admission);
    expect(second.next).toHaveBeenCalledTimes(1);
  });

  it("still releases on disconnect while the body is arriving", () => {
    // The other half: nothing downstream has taken ownership yet, so holding the
    // reservation would be a budget that shrinks over the process's lifetime.
    const admission = createRestoreUploadAdmission(LIMIT);
    const { res } = admit(admission);

    res.raw.emit("close");

    expect(admission.reservedBytes()).toBe(0);
  });

  it("releases once when the handler and the response both report in", () => {
    const admission = createRestoreUploadAdmission(LIMIT);
    const { req, res } = admit(admission, 100);
    bodyArrived(req);

    releaseRestoreReservation(req);
    res.raw.emit("finish");
    res.raw.emit("close");

    // Not negative: a double release would let the budget grow past the
    // container, which is worse than not having one.
    expect(admission.reservedBytes()).toBe(0);
  });

  it("is safe to call the release hook on a request that was never admitted", () => {
    // The controller calls it unconditionally in a `finally`, including on a
    // request that never went through the gate.
    expect(() => releaseRestoreReservation(request())).not.toThrow();
    expect(() => releaseRestoreReservation(undefined)).not.toThrow();
    expect(() => releaseRestoreReservation({})).not.toThrow();
  });
});

/**
 * The peak multiple (F3R5-002).
 *
 * The first version reserved the declared `Content-Length` and nothing else,
 * which counted the smallest of the buffers a restore holds. An encrypted upload
 * is the envelope, plus the decipher output, plus the concatenated plaintext,
 * plus the decompressed payload, plus the string, plus the parsed graph -- several
 * live at once. Three 60 MiB uploads declared 180 MiB, fitted a 200 MiB budget,
 * and could pass 540 MiB in flight.
 */
describe("restore upload admission peak budgeting", () => {
  const LIMIT = 200 * MIB;

  /** The container the chart defaults to, and the limits derived from it. */
  const CONTAINER = 400 * MIB;
  const WIRE_LIMIT = resolveRestoreUploadLimitBytes(undefined, CONTAINER);
  const BUDGET = WIRE_LIMIT * PEAK_MULTIPLE;

  it("keeps a single full-size upload's peak inside the container", () => {
    // The arithmetic that was wrong one level up: half of a 400 MiB container to
    // the *wire* is PEAK_MULTIPLE times that at peak, so one legal request could
    // not fit the pod it was sized for. The wire ceiling is now the expanded
    // ceiling, which is itself solved out of the memory left after the process
    // baseline -- so what has to fit is the whole modeled peak, not a share.
    expect(restoreProcessBaselineBytes(CONTAINER) + BUDGET).toBeLessThanOrEqual(
      CONTAINER,
    );

    const admission = createRestoreUploadAdmission(WIRE_LIMIT, BUDGET);
    const next = jest.fn();
    admission.middleware(
      request({ "content-length": String(WIRE_LIMIT) }),
      response().res,
      next,
    );
    // A ceiling that refuses the largest legal request would be an outage, not a
    // protection.
    expect(next).toHaveBeenCalledTimes(1);
    expect(admission.reservedBytes()).toBe(BUDGET);
  });

  it("refuses the several-small-uploads case the wire-byte version admitted", () => {
    // The reviewer's numbers: three 60 MiB encrypted envelopes, each legal on its
    // own, declaring 180 MiB between them. Under wire-byte accounting all three
    // were admitted onto a 400 MiB pod and could pass 540 MiB in flight.
    const admission = createRestoreUploadAdmission(WIRE_LIMIT, BUDGET);
    const outcomes = [0, 1, 2].map(() => {
      const next = jest.fn();
      admission.middleware(
        request({ "content-length": String(60 * MIB) }),
        response().res,
        next,
      );
      return next.mock.calls.length === 1;
    });

    expect(outcomes.filter(Boolean).length).toBeLessThan(3);
    // Whatever was admitted, its peak fits the share.
    expect(admission.reservedBytes()).toBeLessThanOrEqual(BUDGET);
  });

  it("counts more than the wire bytes for a single upload", () => {
    const admission = createRestoreUploadAdmission(LIMIT);
    admission.middleware(
      request({ "content-length": String(60 * MIB) }),
      response().res,
      jest.fn(),
    );

    // The defect was reserving exactly 60 MiB for a request that will hold
    // several times that at its peak.
    expect(admission.reservedBytes()).toBe(60 * MIB * PEAK_MULTIPLE);
  });
});

/**
 * A body that never arrives (F3R5-004).
 *
 * The gate necessarily runs before authentication, and a chunked request declares
 * no length, so it reserves the whole ceiling. Without a deadline an
 * unauthenticated client could open one, trickle or withhold the body, and hold
 * the recovery path closed for as long as the socket survived -- during exactly
 * the incident a restore is for.
 */
describe("restore upload admission receive deadline", () => {
  const LIMIT = 200 * MIB;

  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it("reclaims the reservation from a body that never arrives", () => {
    const admission = createRestoreUploadAdmission(
      LIMIT,
      undefined,
      undefined,
      1000,
    );
    const req = request();
    const res = response();
    admission.middleware(req, res.res, jest.fn());
    expect(admission.reservedBytes()).toBe(LIMIT * PEAK_MULTIPLE);

    jest.advanceTimersByTime(1000);

    expect(admission.reservedBytes()).toBe(0);
    expect(res.raw.statusCode).toBe(408);
    expect(res.headers["retry-after"]).toBe("30");
    // The socket goes too, or the client keeps a connection it can retry on for
    // free while holding nothing.
    expect(req.destroyed).toBe(true);

    // And the legitimate caller gets in.
    const next = jest.fn();
    admission.middleware(
      request({ "content-length": String(100 * MIB) }),
      response().res,
      next,
    );
    expect(next).toHaveBeenCalledTimes(1);
  });

  it("does not time out a slow restore, only a slow upload", () => {
    // The deadline is armed while receiving and disarmed when the body lands. A
    // timeout on *processing* would be the release-too-early defect with a delay
    // -- it would free memory the restore is still using.
    const admission = createRestoreUploadAdmission(
      LIMIT,
      undefined,
      undefined,
      1000,
    );
    const req = request({ "content-length": String(100 * MIB) });
    const res = response();
    admission.middleware(req, res.res, jest.fn());

    bodyArrived(req);
    jest.advanceTimersByTime(60_000);

    expect(admission.reservedBytes()).toBe(100 * MIB * PEAK_MULTIPLE);
    expect(res.raw.statusCode).toBe(200);
    expect(req.destroyed).toBe(false);
  });

  it("has a default deadline rather than waiting forever", () => {
    const admission = createRestoreUploadAdmission(LIMIT);
    const req = request();
    admission.middleware(req, response().res, jest.fn());

    jest.advanceTimersByTime(DEFAULT_RECEIVE_TIMEOUT_MS);

    expect(admission.reservedBytes()).toBe(0);
  });
});

/**
 * The gate has to sit **before** the body parser, and the ordering is in
 * `main.ts`, which is excluded from coverage and has no test harness. So this is
 * a source guard: it is the whole point of the change, and getting it backwards
 * would leave the middleware running after the allocation it exists to prevent.
 */
describe("restore upload admission wiring", () => {
  it("registers admission ahead of express.raw", () => {
    const source = fs.readFileSync(
      path.join(__dirname, "..", "main.ts"),
      "utf8",
    );

    const admissionAt = source.indexOf("restoreAdmission.middleware");
    const parserAt = source.indexOf("express.raw({");
    expect(admissionAt).toBeGreaterThan(-1);
    expect(parserAt).toBeGreaterThan(-1);
    expect(admissionAt).toBeLessThan(parserAt);
  });

  /**
   * CORS has to be registered before the gate, because the gate answers requests
   * itself: a 403/413/503/408 written from inside the middleware chain with no
   * Access-Control-Allow-Origin reaches a cross-origin browser as an opaque CORS
   * failure instead of the actionable status it is. Ordering in `main.ts` is not
   * covered by any test harness, so it is scanned for -- the same reason the
   * express.raw ordering above is.
   */
  it("registers CORS ahead of the admission middleware", () => {
    const source = fs.readFileSync(
      path.join(__dirname, "..", "main.ts"),
      "utf8",
    );
    const corsAt = source.indexOf("app.enableCors(");
    const admissionAt = source.indexOf("restoreAdmission.middleware");
    expect(corsAt).toBeGreaterThan(-1);
    expect(admissionAt).toBeGreaterThan(-1);
    expect(corsAt).toBeLessThan(admissionAt);
  });

  /**
   * And that the gate is actually built with an authorizer. The hook is optional
   * -- unit tests of the budgeting want it omitted -- so nothing but a scan
   * catches a deployment that quietly went back to admitting everyone.
   */
  it("builds the gate with the ticket authorizer", () => {
    const source = fs.readFileSync(
      path.join(__dirname, "..", "main.ts"),
      "utf8",
    );
    // The CALL, not the import -- which is why the needle carries its argument:
    // matching the bare identifier finds the import line and passes on a file
    // that imports the authorizer and never uses it.
    const call = "createRestoreTicketAuthorizer(process.env.JWT_SECRET)";
    expect(source).toContain(call);
    expect(source.indexOf(call)).toBeGreaterThan(
      source.indexOf("createRestoreUploadAdmission("),
    );
  });
});
