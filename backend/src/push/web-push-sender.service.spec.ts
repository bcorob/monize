import * as https from "node:https";
import * as webpush from "web-push";
import {
  collectAgentSockets,
  WebPushSender,
  MAX_CONSECUTIVE_FAILURES,
  PUSH_DEADLINE_MESSAGE,
  PUSH_ENDPOINT_RECHECK_TIMEOUT_MS,
  PUSH_REQUEST_DEADLINE_MS,
  PUSH_REQUEST_TIMEOUT_MS,
  PushPayload,
  PushTarget,
} from "./web-push-sender.service";
import { publicOnlyLookup } from "../ai/providers/provider-egress";
import { PushConfigService, VAPID_SUBJECT } from "./push-config.service";
import { PushDisabledReason } from "./entities/push-subscription.entity";

jest.mock("web-push", () => ({
  sendNotification: jest.fn(),
  generateVAPIDKeys: jest.fn(),
}));

// The sender re-checks the endpoint before every send; this double keeps the
// suite off real DNS and lets one test drive the refusal.
//
// The real module is spread rather than replaced. A bare factory blanks every
// other export -- and the sender reads `URL_SAFETY_CHECK_TIMEOUT_MS` from here,
// so a replaced module made the recheck bound `undefined` and every test in this
// file failed somewhere else entirely.
jest.mock("../ai/validators/safe-url.validator", () => ({
  ...jest.requireActual("../ai/validators/safe-url.validator"),
  validateUrlIsSafeWithin: jest.fn().mockResolvedValue(true),
}));

const sendNotification = webpush.sendNotification as jest.Mock;
const validateUrlIsSafeWithin = jest.requireMock(
  "../ai/validators/safe-url.validator",
).validateUrlIsSafeWithin as jest.Mock;

const IDENTITY = { publicKey: "PUB-CURRENT", privateKey: "PRIV" };

function target(overrides: Partial<PushTarget> = {}) {
  return {
    endpoint: "https://fcm.googleapis.com/fcm/send/abc",
    p256dh: "p256dh-value",
    auth: "auth-value",
    vapidPublicKey: "PUB-CURRENT",
    ...overrides,
  };
}

const PAYLOAD: PushPayload = {
  type: "TEST",
  title: "t",
  body: "b",
  target: "/settings",
  collapseKey: null,
};

describe("collectAgentSockets", () => {
  /**
   * The mechanism the deadline depends on. Tested on its own because the
   * delivery path cannot reach inside `https.Agent` to prove it: a test that
   * drives a real connection is a test about the network.
   */
  it("records every connection the agent opens and returns it unchanged", () => {
    const first = { id: 1, destroy: jest.fn() } as unknown as ReturnType<
      https.Agent["createConnection"]
    >;
    const second = { id: 2, destroy: jest.fn() } as unknown as typeof first;
    const answers = [first, second];
    const agent = {
      createConnection: jest.fn(() => answers.shift()),
    } as unknown as https.Agent;

    const sockets = collectAgentSockets(agent);
    const returnedFirst = (
      agent as unknown as { createConnection: (o: unknown) => unknown }
    ).createConnection({ host: "a" });
    const returnedSecond = (
      agent as unknown as { createConnection: (o: unknown) => unknown }
    ).createConnection({ host: "b" });

    // Recorded, in order, and handed back untouched -- a wrapper that returned
    // something else would break the delivery it is meant to observe.
    expect(sockets).toEqual([first, second]);
    expect(returnedFirst).toBe(first);
    expect(returnedSecond).toBe(second);
  });

  // Node's agent contract permits `createConnection(options, oncreate)` to hand
  // the socket to its callback and return undefined (`_http_agent` does
  // `if (newSocket) oncreate(...)` for exactly that). Recorded anyway, the
  // deadline's `socket.destroy()` throws inside a setTimeout -- an uncaught
  // exception that takes the process with it, and the rejection beside it never
  // runs, so the delivery never settles either.
  it.each([
    ["undefined", undefined],
    ["null", null],
    ["something with no destroy", { id: 1 }],
  ])("records nothing when the agent returns %s", (_name, answer) => {
    const agent = {
      createConnection: jest.fn(() => answer as never),
    } as unknown as https.Agent;

    const sockets = collectAgentSockets(agent);
    const returned = (
      agent as unknown as { createConnection: (o: unknown) => unknown }
    ).createConnection({ host: "a" });

    expect(sockets).toEqual([]);
    // Still handed back untouched: the wrapper observes, it does not decide.
    expect(returned).toBe(answer);
  });

  it("forwards the arguments it was given", () => {
    const createConnection = jest.fn(() => ({ destroy: jest.fn() }) as never);
    const agent = { createConnection } as unknown as https.Agent;

    collectAgentSockets(agent);
    (
      agent as unknown as { createConnection: (...a: unknown[]) => unknown }
    ).createConnection({ host: "a" }, "cb");

    expect(createConnection).toHaveBeenCalledWith({ host: "a" }, "cb");
  });
});

describe("WebPushSender", () => {
  let sender: WebPushSender;
  let pushConfig: { getVapidIdentity: jest.Mock };

  beforeEach(() => {
    jest.clearAllMocks();
    validateUrlIsSafeWithin.mockResolvedValue(true);
    pushConfig = { getVapidIdentity: jest.fn().mockResolvedValue(IDENTITY) };
    sender = new WebPushSender(pushConfig as unknown as PushConfigService);
    jest.spyOn(sender["logger"], "warn").mockImplementation(() => undefined);
  });

  // The production caller fans out through an opened batch; one target is the
  // simplest batch, and every outcome below is a claim about one delivery.
  const sendOne = (t: ReturnType<typeof target>, p: typeof PAYLOAD) =>
    sender.openBatch().then((batch) => batch.send(t, p));

  it("uses a pinned private address only for UnifiedPush, and rechecks after removal", async () => {
    const original = process.env.UNIFIEDPUSH_PRIVATE_ENDPOINTS;
    process.env.UNIFIEDPUSH_PRIVATE_ENDPOINTS = JSON.stringify({
      "https://ntfy.home.lan:8443": "192.168.20.5",
    });
    validateUrlIsSafeWithin.mockResolvedValue(false);
    sendNotification.mockResolvedValue(undefined);
    try {
      const t = target({
        endpoint: "https://ntfy.home.lan:8443/topic",
        transport: "unifiedpush",
      });
      expect(await sendOne(t, PAYLOAD)).toEqual({ status: "sent" });
      const options = sendNotification.mock.calls[0][2];
      const callback = jest.fn();
      options.agent.options.lookup("ntfy.home.lan", {}, callback);
      expect(callback).toHaveBeenCalledWith(null, "192.168.20.5", 4);
      expect(options.agent.options.rejectUnauthorized).not.toBe(false);
      sendNotification.mockClear();
      expect(
        await sendOne({ ...t, transport: "webpush" }, PAYLOAD),
      ).toMatchObject({ status: "transient" });
      expect(sendNotification).not.toHaveBeenCalled();
      process.env.UNIFIEDPUSH_PRIVATE_ENDPOINTS = "";
      expect(await sendOne(t, PAYLOAD)).toMatchObject({ status: "transient" });
      expect(sendNotification).not.toHaveBeenCalled();
    } finally {
      if (original === undefined)
        delete process.env.UNIFIEDPUSH_PRIVATE_ENDPOINTS;
      else process.env.UNIFIEDPUSH_PRIVATE_ENDPOINTS = original;
    }
  });

  it("connects an unpinned endpoint through publicOnlyLookup", async () => {
    sendNotification.mockResolvedValue(undefined);
    expect(await sendOne(target(), PAYLOAD)).toEqual({ status: "sent" });
    expect(sendNotification.mock.calls[0][2].agent.options.lookup).toBe(
      publicOnlyLookup,
    );
  });

  it("reads the instance identity once for a whole batch, and not at all for nothing", async () => {
    sendNotification.mockResolvedValue(undefined);
    const batch = await sender.openBatch();
    await Promise.all([
      batch.send(target(), PAYLOAD),
      batch.send(target(), PAYLOAD),
      batch.send(target(), PAYLOAD),
    ]);
    expect(pushConfig.getVapidIdentity).toHaveBeenCalledTimes(1);
    expect(sendNotification).toHaveBeenCalledTimes(3);
    expect(batch.ready).toBe(true);
  });

  it("reports a batch as not ready when the instance has no usable identity", async () => {
    pushConfig.getVapidIdentity.mockResolvedValue(null);
    const batch = await sender.openBatch();
    expect(batch.ready).toBe(false);
    await expect(batch.send(target(), PAYLOAD)).resolves.toEqual({
      status: "unconfigured",
    });
    expect(sendNotification).not.toHaveBeenCalled();
  });

  /**
   * The endpoint is a host the CALLER registered -- `IsPushEndpoint` proves it is
   * https and public, not that it is a push service -- so a peer that never
   * finishes is reachable on purpose. `web-push`'s own `timeout` is Node's socket
   * INACTIVITY timer, which a host that trickles one byte at a time resets
   * forever, and its response reader is `responseText += chunk` with no cap. So
   * the bound has to be ours, and losing the race has to CLOSE the socket rather
   * than merely abandon the promise.
   */
  describe("the whole-delivery deadline", () => {
    afterEach(() => {
      jest.useRealTimers();
    });

    it("gives up on a delivery that never finishes", async () => {
      sendNotification.mockImplementation(
        () =>
          new Promise(() => {
            // Never settles: the peer is still "answering".
          }),
      );
      jest.useFakeTimers();

      const pending = sendOne(target(), PAYLOAD);
      await jest.advanceTimersByTimeAsync(PUSH_REQUEST_DEADLINE_MS + 1);

      // Reported as transient, which is what actually happened: the bounded
      // retry retires the device as FAILING rather than pretending it is gone.
      await expect(pending).resolves.toMatchObject({
        status: "transient",
        message: PUSH_DEADLINE_MESSAGE,
      });
    });

    it("hands the delivery an agent whose sockets it can close", async () => {
      sendNotification.mockResolvedValue(undefined);

      await sendOne(target(), PAYLOAD);

      const [, , options] = sendNotification.mock.calls[0];
      // Not the global agent: the deadline destroys sockets, and destroying a
      // pooled socket somebody else is using would be a different bug.
      expect(options.agent).toBeInstanceOf(https.Agent);
    });

    it("keeps the inactivity timeout as well, for a peer that simply goes quiet", async () => {
      sendNotification.mockResolvedValue(undefined);

      await sendOne(target(), PAYLOAD);

      const [, , options] = sendNotification.mock.calls[0];
      expect(options.timeout).toBe(PUSH_REQUEST_TIMEOUT_MS);
      expect(options.agent).toBeDefined();
    });

    it("is more generous than the inactivity timeout, so slow is not stalled", () => {
      // A real push service answering slowly under load must not be mistaken
      // for a host that is holding the socket open.
      expect(PUSH_REQUEST_DEADLINE_MS).toBeGreaterThan(PUSH_REQUEST_TIMEOUT_MS);
    });
  });

  it("signs with the instance identity and reports a send", async () => {
    sendNotification.mockResolvedValue(undefined);

    await expect(sendOne(target(), PAYLOAD)).resolves.toEqual({
      status: "sent",
    });

    const [subscription, body, options] = sendNotification.mock.calls[0];
    expect(subscription).toEqual({
      endpoint: "https://fcm.googleapis.com/fcm/send/abc",
      keys: { p256dh: "p256dh-value", auth: "auth-value" },
    });
    expect(JSON.parse(body)).toEqual(PAYLOAD);
    expect(options.vapidDetails).toEqual({
      subject: VAPID_SUBJECT,
      publicKey: "PUB-CURRENT",
      privateKey: "PRIV",
    });
    // Node's https client has no default timeout and web-push adds none, so a
    // user-supplied endpoint host that stalls would hold the socket -- and the
    // request that triggered the send -- for as long as it liked.
    expect(options.timeout).toBe(PUSH_REQUEST_TIMEOUT_MS);
  });

  // The endpoint is SSRF-checked when the row is written, and the row then names
  // a host this server POSTs to for as long as it lives. A name that resolved
  // publicly then and resolves to a private address now must not become an
  // internal request.
  it("refuses to send to an endpoint that no longer resolves publicly", async () => {
    validateUrlIsSafeWithin.mockResolvedValue(false);

    await expect(sendOne(target(), PAYLOAD)).resolves.toMatchObject({
      status: "transient",
    });
    expect(sendNotification).not.toHaveBeenCalled();
  });

  // The check resolves DNS, and dns.resolve4/6 carry no timeout of their own, so
  // a stalled nameserver would sit in front of the HTTP send and the request
  // timeout would bound only the half that had already got past it. The bound
  // itself lives with the check (`safe-url-dns.spec.ts` drives a resolver that
  // never answers); what this file owns is that the sender asks for it.
  it("asks for the check under the recheck bound", async () => {
    await sendOne(target(), PAYLOAD);

    expect(validateUrlIsSafeWithin).toHaveBeenCalledWith(
      target().endpoint,
      PUSH_ENDPOINT_RECHECK_TIMEOUT_MS,
    );
  });

  // A check that timed out answers false, and false is a refusal rather than a
  // send: not knowing whether a host is public is not the same as knowing it is.
  it("does not send when the check gave up", async () => {
    validateUrlIsSafeWithin.mockResolvedValue(false);

    await expect(sendOne(target(), PAYLOAD)).resolves.toMatchObject({
      status: "transient",
    });
    expect(sendNotification).not.toHaveBeenCalled();
  });

  // Not knowing whether a host is public is not the same as knowing it is.
  it("does not send when the check itself fails", async () => {
    validateUrlIsSafeWithin.mockRejectedValue(new Error("resolver exploded"));

    await expect(sendOne(target(), PAYLOAD)).resolves.toMatchObject({
      status: "transient",
    });
    expect(sendNotification).not.toHaveBeenCalled();
  });

  it("reports unconfigured, and sends nothing, when the instance has no usable identity", async () => {
    pushConfig.getVapidIdentity.mockResolvedValue(null);

    await expect(sendOne(target(), PAYLOAD)).resolves.toEqual({
      status: "unconfigured",
    });
    expect(sendNotification).not.toHaveBeenCalled();
  });

  it("refuses a subscription minted under a superseded key pair without calling out", async () => {
    await expect(
      sendOne(target({ vapidPublicKey: "PUB-OLD" }), PAYLOAD),
    ).resolves.toEqual({
      status: "expired",
      reason: PushDisabledReason.KEY_ROTATED,
    });
    // The push service would answer 403; asking it costs a round trip and tells
    // us nothing we do not already know from the stored key.
    expect(sendNotification).not.toHaveBeenCalled();
  });

  it.each([404, 410])(
    "treats %s from the push service as a gone subscription",
    async (statusCode) => {
      sendNotification.mockRejectedValue(
        Object.assign(new Error("gone"), { statusCode }),
      );

      await expect(sendOne(target(), PAYLOAD)).resolves.toEqual({
        status: "expired",
        reason: PushDisabledReason.GONE,
        statusCode,
      });
    },
  );

  // The regression this pins: retiring a device on an authorization failure
  // would empty every device list in the deployment over one bad clock or key.
  it.each([400, 401, 403, 413, 500, 503])(
    "treats %s as transient rather than retiring the device",
    async (statusCode) => {
      sendNotification.mockRejectedValue(
        Object.assign(new Error("nope"), { statusCode }),
      );

      const outcome = await sendOne(target(), PAYLOAD);

      expect(outcome).toEqual({
        status: "transient",
        message: "nope",
        statusCode,
      });
    },
  );

  // 429 is the push service throttling this INSTANCE -- one deployment holds one
  // VAPID key pair, so it is per origin and says nothing about the device.
  // Counted like any other transient failure it would retire every device in the
  // deployment during one outage.
  it("marks a throttle as not the device's failure", async () => {
    sendNotification.mockRejectedValue(
      Object.assign(new Error("Too Many Requests"), { statusCode: 429 }),
    );

    await expect(sendOne(target(), PAYLOAD)).resolves.toEqual({
      status: "transient",
      message: "Too Many Requests",
      statusCode: 429,
      throttled: true,
    });
  });

  // ...and nothing else is. A 401 or a 500 may well be about this endpoint, and
  // the retirement bound is what stops a dead one being attempted forever.
  it.each([[401], [403], [500], [503]])(
    "leaves %s counting against the device",
    async (statusCode) => {
      sendNotification.mockRejectedValue(
        Object.assign(new Error("nope"), { statusCode }),
      );

      const outcome = await sendOne(target(), PAYLOAD);

      expect(outcome).toMatchObject({ status: "transient", statusCode });
      expect(outcome).not.toHaveProperty("throttled");
    },
  );

  it("treats a transport error with no status code as transient", async () => {
    sendNotification.mockRejectedValue(new Error("socket hang up"));

    await expect(sendOne(target(), PAYLOAD)).resolves.toEqual({
      status: "transient",
      message: "socket hang up",
      statusCode: undefined,
    });
  });

  it("never throws, whatever the transport rejects with", async () => {
    sendNotification.mockRejectedValue("a bare string");

    await expect(sendOne(target(), PAYLOAD)).resolves.toEqual({
      status: "transient",
      message: "unknown push failure",
      statusCode: undefined,
    });
  });

  it("bounds retry at a value a working device never reaches", () => {
    // The constant is the whole of "bounded retry"; a spec that did not name it
    // would let it be raised to Infinity without a failure.
    expect(MAX_CONSECUTIVE_FAILURES).toBeGreaterThan(1);
    expect(Number.isFinite(MAX_CONSECUTIVE_FAILURES)).toBe(true);
  });
});
