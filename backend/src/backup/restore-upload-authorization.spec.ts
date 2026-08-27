import { PEAK_MULTIPLE } from "./backup-limits";
import { createRestoreUploadAdmission } from "./restore-upload-admission";
import { request, response } from "./__fixtures__/http-doubles";

const MIB = 1024 * 1024;

/**
 * DR-F3RB-003. The gate runs in front of the body parser, so it cannot
 * authenticate -- which meant an unauthenticated client could occupy the restore
 * budget until the receive deadline expired, degrading a legitimate restore to a
 * retry during exactly the incident a restore is for. Authorization therefore
 * moved in front of the reservation.
 */
describe("restore upload admission authorization", () => {
  const LIMIT = 50 * MIB;
  const admit = () => ({ ok: true }) as const;
  const refuse = () =>
    ({ ok: false, status: 403, message: "no ticket" }) as const;

  it("reserves nothing for a request it refuses", () => {
    const admission = createRestoreUploadAdmission(
      LIMIT,
      LIMIT * PEAK_MULTIPLE,
      undefined,
      undefined,
      refuse,
    );
    const next = jest.fn();
    const { res, headers } = response();
    admission.middleware(
      request({ "content-length": String(10 * MIB) }),
      res,
      next,
    );

    // The whole point: not one byte promised, and the request never reaches the
    // parser it would have allocated in.
    expect(admission.reservedBytes()).toBe(0);
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(403);
    expect(headers["retry-after"]).toBeUndefined();
  });

  it("cannot be starved by refused requests", () => {
    // Before the check moved, each of these would have held its claim until the
    // receive deadline; a handful of them closed the recovery path.
    const admission = createRestoreUploadAdmission(
      LIMIT,
      LIMIT * PEAK_MULTIPLE,
      undefined,
      undefined,
      refuse,
    );
    for (let i = 0; i < 20; i += 1) {
      admission.middleware(
        request({ "content-length": String(LIMIT) }),
        response().res,
        jest.fn(),
      );
    }
    expect(admission.reservedBytes()).toBe(0);
  });

  it("admits an authorized request exactly as before", () => {
    const admission = createRestoreUploadAdmission(
      LIMIT,
      LIMIT * PEAK_MULTIPLE,
      undefined,
      undefined,
      admit,
    );
    const next = jest.fn();
    admission.middleware(
      request({ "content-length": String(10 * MIB) }),
      response().res,
      next,
    );
    expect(next).toHaveBeenCalledTimes(1);
    expect(admission.reservedBytes()).toBe(10 * MIB * PEAK_MULTIPLE);
  });

  it("does not consult the authorizer for a request the parser will not buffer", () => {
    // A CORS preflight allocates nothing, so refusing it would turn the
    // protection into a way to deny the upload it protects.
    const authorize = jest.fn(refuse);
    const admission = createRestoreUploadAdmission(
      LIMIT,
      LIMIT * PEAK_MULTIPLE,
      undefined,
      undefined,
      authorize,
    );
    const next = jest.fn();
    admission.middleware(request({}, "OPTIONS"), response().res, next);
    expect(authorize).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledTimes(1);
  });

  it("checks authorization before the size ceiling", () => {
    // An oversized body from an unauthenticated caller is refused as
    // unauthorized, not as too large: 413 tells a stranger what the deployment's
    // limits are, and the earlier refusal is the cheaper one.
    const admission = createRestoreUploadAdmission(
      LIMIT,
      LIMIT * PEAK_MULTIPLE,
      undefined,
      undefined,
      refuse,
    );
    const { res } = response();
    admission.middleware(
      request({ "content-length": String(LIMIT * 4) }),
      res,
      jest.fn(),
    );
    expect(res.statusCode).toBe(403);
  });

  it("admits everything when no authorizer is supplied", () => {
    // The budgeting tests above build the gate without one, so this is the
    // behaviour they rely on -- stated rather than assumed.
    const admission = createRestoreUploadAdmission(LIMIT);
    const next = jest.fn();
    admission.middleware(
      request({ "content-length": String(MIB) }),
      response().res,
      next,
    );
    expect(next).toHaveBeenCalledTimes(1);
  });
});
