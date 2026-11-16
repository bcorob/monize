import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from "@nestjs/common";
import { I18nService } from "nestjs-i18n";
import { In, IsNull } from "typeorm";
import {
  PushSubscriptionService,
  ENDPOINT_FINGERPRINT_LENGTH,
  ENDPOINT_UNIQUE_INDEX,
  MAX_LIVE_DEVICES_PER_USER,
  MAX_USER_AGENT_LENGTH,
  PUSH_TEST_CONCURRENCY,
  PUSH_TEST_WORST_CASE_MS,
  RETIRED_DEVICE_RETENTION_DAYS,
  HELD_DEVICE_RETENTION_DAYS,
  hashEndpoint,
} from "./push-subscription.service";
import { PushConfigService } from "./push-config.service";
import {
  MAX_CONSECUTIVE_FAILURES,
  PUSH_ENDPOINT_RECHECK_TIMEOUT_MS,
  PUSH_REQUEST_DEADLINE_MS,
  PUSH_REQUEST_TIMEOUT_MS,
  WebPushSender,
} from "./web-push-sender.service";
import {
  PushDisabledReason,
  PushSubscription,
} from "./entities/push-subscription.entity";
import { UserPreference } from "../users/entities/user-preference.entity";
import { createScopedDbMocks } from "../test-helpers/scoped-db-testing";
import { withSystemContext } from "../common/db/with-context";

jest.mock("../common/db/scoped-db", () =>
  jest.requireActual("../test-helpers/scoped-db-testing").scopedDbMockModule(),
);

jest.mock("../common/db/with-context", () => ({
  withSystemContext: jest.fn((fn: () => unknown) => fn()),
}));

const USER = "11111111-1111-4111-8111-111111111111";
const OTHER_USER = "22222222-2222-4222-8222-222222222222";
const ENDPOINT = "https://updates.push.services.mozilla.com/wpush/v2/abcdef";
const DEVICE_ID = "33333333-3333-4333-8333-333333333333";

const DTO = {
  endpoint: ENDPOINT,
  p256dh: "p256dh-value",
  auth: "auth-value",
  applicationServerKey: "PUB",
  deviceName: "Pixel 9",
};

function storedDevice(overrides: Partial<PushSubscription> = {}) {
  return {
    id: DEVICE_ID,
    userId: USER,
    endpoint: ENDPOINT,
    endpointHash: hashEndpoint(ENDPOINT),
    p256dh: "p256dh-value",
    auth: "auth-value",
    deviceName: "Pixel 9",
    userAgent: "Mozilla/5.0",
    registeredIp: "203.0.113.7",
    vapidPublicKey: "PUB",
    createdAt: new Date("2026-08-01T10:00:00Z"),
    lastSeenAt: new Date("2026-08-02T10:00:00Z"),
    lastSuccessAt: null,
    failureCount: 0,
    disabledAt: null,
    disabledReason: null,
    heldAt: null,
    ...overrides,
  } as PushSubscription;
}

/**
 * The value bound to one column of the subscribe INSERT, addressed by NAME.
 *
 * A positional `insert[1][8]` is a claim about the column list that nothing
 * checks: adding `registered_ip` ahead of `transport` shifted every index by
 * one and two assertions started reading the neighbouring value while still
 * passing their own `toBe`. The column list is checked against `schema.sql` by
 * `raw-sql-columns.spec.ts`; this reads the same list at run time so a spec can
 * never disagree with it.
 */
function insertParam(
  call: [unknown, unknown[]] | undefined,
  column: string,
): unknown {
  expect(call).toBeDefined();
  const sql = String(call![0]);
  const columns = sql
    .slice(sql.indexOf("(") + 1, sql.indexOf(")"))
    .split(",")
    .map((name) => name.trim());
  const index = columns.indexOf(column);
  expect(columns).toContain(column);
  return call![1][index];
}

function subscribeInsert(
  manager: ReturnType<typeof createScopedDbMocks>["manager"],
) {
  return (manager.query as jest.Mock).mock.calls.find(([sql]) =>
    String(sql).includes("INSERT INTO push_subscriptions"),
  ) as [unknown, unknown[]] | undefined;
}

describe("PushSubscriptionService", () => {
  const charts = {
    render: jest.fn().mockResolvedValue(null),
    issue: jest.fn().mockResolvedValue(null),
  };
  let service: PushSubscriptionService;
  let subscriptionRepo: Record<string, jest.Mock>;
  let preferenceRepo: Record<string, jest.Mock>;
  let manager: ReturnType<typeof createScopedDbMocks>["manager"];
  let dataSource: ReturnType<typeof createScopedDbMocks>["dataSource"];
  let pushConfig: { getPublicConfig: jest.Mock };
  let send: jest.Mock;
  let sender: { openBatch: jest.Mock; send: jest.Mock };

  beforeEach(() => {
    jest.clearAllMocks();
    subscriptionRepo = {
      find: jest.fn().mockResolvedValue([]),
      findOne: jest.fn().mockResolvedValue(storedDevice()),
      count: jest.fn().mockResolvedValue(0),
    };
    preferenceRepo = {
      findOne: jest.fn().mockResolvedValue({ language: "en" }),
    };
    ({ manager, dataSource } = createScopedDbMocks([
      [PushSubscription, subscriptionRepo],
      [UserPreference, preferenceRepo],
    ]));
    manager.query.mockResolvedValue([[{ id: DEVICE_ID }], 1]);
    pushConfig = {
      getPublicConfig: jest.fn().mockResolvedValue({
        enabled: true,
        publicKey: "PUB",
        configured: true,
      }),
    };
    // `openBatch` hands back the one bound sender a fan-out delivers through;
    // `sender.send` here is that inner mock, so the assertions below read as
    // "what was delivered" without restating the batch handshake each time.
    send = jest.fn().mockResolvedValue({ status: "sent" });
    sender = { openBatch: jest.fn(async () => ({ ready: true, send })), send };
    service = new PushSubscriptionService(
      dataSource as never,
      pushConfig as unknown as PushConfigService,
      sender as unknown as WebPushSender,
      { translate: jest.fn((key: string) => key) } as unknown as I18nService,
      charts as any,
    );
  });

  describe("subscribe", () => {
    it("binds the owner from its own argument and never from the payload", async () => {
      await service.subscribe(USER, DTO, "Mozilla/5.0");

      const insert = manager.query.mock.calls.find(([sql]) =>
        String(sql).includes("INSERT INTO push_subscriptions"),
      );
      expect(insert).toBeDefined();
      expect(insert![1][0]).toBe(USER);
      // A payload-supplied owner is not merely ignored: there is no field for it.
      expect(Object.keys(DTO)).not.toContain("userId");
    });

    /**
     * The address a registration came from, so the device list can tell two
     * browsers on one machine apart -- `device_name` is derived from the
     * User-Agent and is identical for both.
     *
     * Asserted as the statement's own column list and parameter, not as a
     * substring: a `toContain` on the SQL passes for a column named in the
     * INSERT and never given a value.
     */
    it("stores the address the registration came from", async () => {
      await service.subscribe(USER, DTO, "Mozilla/5.0", "203.0.113.7");

      expect(insertParam(subscribeInsert(manager), "registered_ip")).toBe(
        "203.0.113.7",
      );
    });

    // A re-registration IS a registration, from wherever the browser is now, so
    // the refresh arm overwrites rather than COALESCEs: an older address under a
    // moved `last_seen_at` would make the pair a lie.
    it("refreshes the address on a re-registration rather than keeping the old one", async () => {
      await service.subscribe(USER, DTO, "Mozilla/5.0", "198.51.100.9");

      const sql = String(subscribeInsert(manager)![0]);
      expect(sql).toContain("registered_ip = EXCLUDED.registered_ip");
      expect(sql).not.toContain(
        "registered_ip = COALESCE(EXCLUDED.registered_ip",
      );
    });

    // Unknown is a state: an address this server could not determine is stored
    // as NULL rather than as a placeholder nobody was at.
    it("stores no address when the caller supplied none", async () => {
      await service.subscribe(USER, DTO, "Mozilla/5.0", null);

      expect(insertParam(subscribeInsert(manager), "registered_ip")).toBeNull();
    });

    // The rule this pins, and the reason the previous shape was wrong: an
    // endpoint is a string the caller supplied, and it proves nothing about
    // what they own. Deleting another account's row on the strength of it was a
    // cross-tenant destructive write -- and a silent one, so the first account
    // lost push with no notice. One row per endpoint, and the second subscriber
    // is refused.
    it("touches no row belonging to another account", async () => {
      await service.subscribe(USER, DTO, null);

      const sqls = manager.query.mock.calls.map(([sql]) => String(sql));
      expect(sqls.some((sql) => sql.includes("DELETE"))).toBe(false);
      for (const [sql, params] of manager.query.mock.calls) {
        // Every statement this path issues is scoped to the caller, either by
        // an explicit predicate or by the value it inserts.
        expect(String(sql)).not.toContain("user_id <>");
        expect(params).toContain(USER);
      }
    });

    it("refuses when the endpoint is registered to another account", async () => {
      manager.query.mockResolvedValue([[], 0]);
      // The cap check reads first; the read-back after the insert is the one
      // that must not happen once the write was refused.
      subscriptionRepo.findOne.mockResolvedValue(null);

      await expect(service.subscribe(USER, DTO, null)).rejects.toThrow(
        ConflictException,
      );
      expect(manager.query).toHaveBeenCalledTimes(1);
    });

    // `sendTest` fans out over every live row, so one account's request would
    // otherwise cost whatever that account chose to make it cost.
    it("refuses a new device past the per-account cap", async () => {
      subscriptionRepo.findOne.mockResolvedValue(null);
      subscriptionRepo.count.mockResolvedValue(MAX_LIVE_DEVICES_PER_USER);

      await expect(service.subscribe(USER, DTO, null)).rejects.toThrow(
        BadRequestException,
      );
      expect(manager.query).not.toHaveBeenCalled();
    });

    // Refreshing a device the caller already holds adds nothing, so the cap
    // must not lock them out of the browser they are sitting at.
    it("still refreshes a device the caller already holds at the cap", async () => {
      subscriptionRepo.count.mockResolvedValue(MAX_LIVE_DEVICES_PER_USER);

      await expect(service.subscribe(USER, DTO, null)).resolves.toMatchObject({
        id: DEVICE_ID,
      });
      const [[lookup]] = subscriptionRepo.findOne.mock.calls;
      // Scoped to LIVE rows: the upsert clears `disabled_at`, so re-enabling a
      // retired device adds a live one and the cap has to count it.
      expect(lookup.where.disabledAt).toBeDefined();
    });

    it("applies the cap when re-enabling a device that had been retired", async () => {
      // No LIVE row for this endpoint -- the retired one does not match.
      subscriptionRepo.findOne.mockResolvedValue(null);
      subscriptionRepo.count.mockResolvedValue(MAX_LIVE_DEVICES_PER_USER);

      await expect(service.subscribe(USER, DTO, null)).rejects.toThrow(
        BadRequestException,
      );
    });

    // Under enforced RLS the conflicting row is invisible to this transaction,
    // so PostgreSQL never reaches the `WHERE user_id = EXCLUDED.user_id` guard:
    // it raises instead. Letting that surface would turn the documented 409
    // into a 500 and silence the client's single retry -- which is the whole
    // recovery path for a stale claim.
    it.each([
      [
        "a unique violation naming the endpoint index",
        Object.assign(new Error("duplicate key"), {
          code: "23505",
          constraint: ENDPOINT_UNIQUE_INDEX,
        }),
      ],
      [
        "the same violation reported only in the message",
        Object.assign(
          new Error(
            `duplicate key value violates unique constraint "${ENDPOINT_UNIQUE_INDEX}"`,
          ),
          { code: "23505" },
        ),
      ],
      [
        "a policy violation on this table",
        Object.assign(
          new Error(
            'new row violates row-level security policy for table "push_subscriptions"',
          ),
          { code: "42501" },
        ),
      ],
      [
        "either of them behind TypeORM's driverError wrapper",
        Object.assign(new Error("wrapped"), {
          driverError: { code: "23505", constraint: ENDPOINT_UNIQUE_INDEX },
        }),
      ],
    ])("answers %s with the same refusal", async (_name, failure) => {
      manager.query.mockRejectedValue(failure);

      await expect(service.subscribe(USER, DTO, null)).rejects.toThrow(
        ConflictException,
      );
    });

    // Anything that is not this statement's documented outcome propagates. The
    // grant case is the one that matters: dressed up as a 409 it would send the
    // client into its automatic recovery, which unsubscribes and destroys a
    // working browser registration before failing again.
    it.each([
      [
        "a missing INSERT grant",
        Object.assign(
          new Error("permission denied for table push_subscriptions"),
          { code: "42501" },
        ),
      ],
      [
        "a unique violation on some other constraint",
        Object.assign(new Error("duplicate key"), {
          code: "23505",
          constraint: "some_other_index",
        }),
      ],
      [
        "a dropped connection",
        Object.assign(new Error("connection terminated"), { code: "57P01" }),
      ],
    ])("does not disguise %s as a refusal", async (_name, failure) => {
      manager.query.mockRejectedValue(failure);

      await expect(service.subscribe(USER, DTO, null)).rejects.toBe(failure);
    });

    it("only writes its own row on the conflict arm", async () => {
      await service.subscribe(USER, DTO, null);

      const [sql] = manager.query.mock.calls.find(([s]) =>
        String(s).includes("INSERT INTO push_subscriptions"),
      )!;
      expect(sql).toContain("ON CONFLICT (endpoint_hash) DO UPDATE");
      expect(sql).toContain(
        "WHERE push_subscriptions.user_id = EXCLUDED.user_id",
      );
      // A re-subscribe from a device that had been retired must come back live.
      expect(sql).toContain("disabled_at = NULL");
      expect(sql).toContain("failure_count = 0");
    });

    // A resume after a sign-out is a re-registration by the same account, so
    // the only arm that may clear the hold is the one the user_id guard covers.
    it("clears a hold on the conflict arm, under the same ownership guard", async () => {
      await service.subscribe(USER, DTO, null);

      const [sql] = manager.query.mock.calls.find(([s]) =>
        String(s).includes("INSERT INTO push_subscriptions"),
      )!;
      const updateArm = String(sql).slice(String(sql).indexOf("DO UPDATE"));
      expect(updateArm).toContain("held_at = NULL");
      expect(updateArm.indexOf("held_at = NULL")).toBeLessThan(
        updateArm.indexOf(
          "WHERE push_subscriptions.user_id = EXCLUDED.user_id",
        ),
      );
    });

    // The response is a read model: on the DO UPDATE arm the stored device name
    // may be the one already there (COALESCE), which this request never saw.
    it("builds the response from the committed row, not from the request", async () => {
      subscriptionRepo.findOne.mockResolvedValue(
        storedDevice({ deviceName: "Name set on an earlier subscribe" }),
      );

      const result = await service.subscribe(USER, DTO, null);

      expect(result.deviceName).toBe("Name set on an earlier subscribe");
      expect(subscriptionRepo.findOne).toHaveBeenCalledWith({
        where: { id: DEVICE_ID },
      });
    });

    it("refuses when the instance has push switched off", async () => {
      pushConfig.getPublicConfig.mockResolvedValue({
        enabled: false,
        publicKey: "PUB",
        configured: true,
      });

      await expect(service.subscribe(USER, DTO, null)).rejects.toThrow(
        BadRequestException,
      );
      expect(manager.query).not.toHaveBeenCalled();
    });

    it("refuses when the instance holds no key pair, so no subscription is stored under a null key", async () => {
      pushConfig.getPublicConfig.mockResolvedValue({
        enabled: true,
        publicKey: null,
        configured: false,
      });

      await expect(service.subscribe(USER, DTO, null)).rejects.toThrow(
        BadRequestException,
      );
      expect(manager.query).not.toHaveBeenCalled();
    });

    it("truncates a user agent to what the column holds", async () => {
      await service.subscribe(USER, DTO, "U".repeat(400));

      const insert = manager.query.mock.calls.find(([sql]) =>
        String(sql).includes("INSERT INTO push_subscriptions"),
      )!;
      expect(insert[1][6]).toHaveLength(MAX_USER_AGENT_LENGTH);
    });

    // The row records the key the BROWSER used, not the server's current value.
    // A rotation between the page load and the click would otherwise stamp a
    // key the subscription does not have, so the sender's KEY_ROTATED guard
    // could never fire and the device would silently 403 until the retry bound
    // retired it with the wrong reason.
    it("refuses a subscription minted under a superseded key", async () => {
      await expect(
        service.subscribe(
          USER,
          { ...DTO, applicationServerKey: "PUB-OLD" },
          null,
        ),
      ).rejects.toThrow(ConflictException);
      expect(manager.query).not.toHaveBeenCalled();
    });

    // Read outside the write's transaction, an administrator's rotation
    // committing in the window between the two left a row whose 409 says it was
    // never written: `disableStaleSubscriptions` cannot retire a row that does
    // not exist yet, so the device was listed as live under a key nothing can be
    // delivered under. `docs/backend/database-access-and-tenancy.md`, "Rejection happens before the write".
    it.each([
      [
        "the channel state",
        { enabled: false, publicKey: "PUB", configured: true },
      ],
      [
        "the current key",
        { enabled: true, publicKey: "PUB-NEW", configured: true },
      ],
    ])("reads %s inside the transaction that writes", async (_name, config) => {
      // Recorded rather than asserted inside the mock: an `expect` that throws
      // there arrives as a rejected `subscribe`, which `rejects.toThrow()` then
      // accepts -- so the test would pass for the pre-fix shape it exists to
      // fail.
      const transactionOpenAtRead: boolean[] = [];
      pushConfig.getPublicConfig.mockImplementation(async () => {
        transactionOpenAtRead.push(
          dataSource.transaction.mock.calls.length > 0,
        );
        return config;
      });

      await expect(service.subscribe(USER, DTO, null)).rejects.toThrow();
      expect(transactionOpenAtRead).toEqual([true]);
      expect(manager.query).not.toHaveBeenCalled();
    });

    it("stamps the subscription with the key pair it was minted under", async () => {
      await service.subscribe(USER, DTO, null);

      expect(insertParam(subscribeInsert(manager), "vapid_public_key")).toBe(
        "PUB",
      );
    });

    // The wire is a fact about the client that registered: a UnifiedPush client
    // says so, a browser says nothing and gets today's only wire. Addressed by
    // column name, never by position (the list is checked against schema.sql by
    // raw-sql-columns.spec.ts).
    it("stores the transport the client registered, defaulting a silent client to webpush", async () => {
      await service.subscribe(USER, DTO, "Mozilla/5.0");
      const browser = subscribeInsert(manager);
      // A silent client binds NULL and the SQL defaults a NEW row to webpush;
      // on a refresh the same NULL keeps the row's existing wire instead.
      expect(insertParam(browser, "transport")).toBeNull();
      expect(String(browser![0])).toContain("COALESCE($10, 'webpush')");

      manager.query.mockClear();
      await service.subscribe(
        USER,
        { ...DTO, transport: "unifiedpush" },
        "ntfy-android/2.11",
      );
      const distributor = subscribeInsert(manager);
      expect(insertParam(distributor, "transport")).toBe("unifiedpush");
      // And the refresh arm keeps the stored wire when the client says nothing,
      // so a UnifiedPush distributor re-posting rotated keys without the tag is
      // not silently moved onto the webpush gate.
      expect(String(distributor![0])).toContain(
        "transport = COALESCE(EXCLUDED.transport, push_subscriptions.transport)",
      );
    });
  });

  describe("listForUser", () => {
    it("lists only the caller's own devices", async () => {
      subscriptionRepo.find.mockResolvedValue([storedDevice()]);

      const devices = await service.listForUser(USER);

      expect(subscriptionRepo.find).toHaveBeenCalledWith({
        where: { userId: USER },
        order: { lastSeenAt: "DESC" },
      });
      expect(devices).toHaveLength(1);
      // A device list is not a place to publish transport credentials: the
      // endpoint plus the two keys are all anyone needs to push to that device.
      expect(Object.keys(devices[0])).not.toContain("endpoint");
      expect(Object.keys(devices[0])).not.toContain("p256dh");
      expect(Object.keys(devices[0])).not.toContain("auth");
      // What it does carry is a digest prefix, so a browser can recognise the
      // row that is itself without the endpoint being handed back.
      expect(devices[0].endpointFingerprint).toBe(
        hashEndpoint(ENDPOINT).slice(0, ENDPOINT_FINGERPRINT_LENGTH),
      );
      expect(devices[0].endpointFingerprint.length).toBeLessThan(
        hashEndpoint(ENDPOINT).length,
      );
    });
  });

  describe("remove", () => {
    it("scopes the delete to the caller inside the transaction that performs it", async () => {
      manager.query.mockResolvedValue([[], 1]);

      await service.remove(USER, DEVICE_ID);

      const [sql, params] = manager.query.mock.calls[0];
      expect(sql).toContain("WHERE id = $1 AND user_id = $2");
      expect(params).toEqual([DEVICE_ID, USER]);
    });

    it("reports a device that is not the caller's as missing", async () => {
      manager.query.mockResolvedValue([[], 0]);

      await expect(service.remove(OTHER_USER, DEVICE_ID)).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe("hold", () => {
    it("binds the device and the caller in one guarded update", async () => {
      manager.query.mockResolvedValue([[], 1]);

      await service.hold(USER, DEVICE_ID);

      expect(manager.query).toHaveBeenCalledTimes(1);
      const [sql, params] = manager.query.mock.calls[0];
      expect(String(sql)).toContain("SET held_at = CURRENT_TIMESTAMP");
      expect(String(sql)).toContain(
        "WHERE id = $1 AND user_id = $2 AND disabled_at IS NULL",
      );
      expect(params).toEqual([DEVICE_ID, USER]);
    });

    // The client reads any refusal as "release instead", so a foreign, missing
    // or retired row must answer rather than succeed over nothing.
    it("reports a device that is not the caller's, or is retired, as missing", async () => {
      manager.query.mockResolvedValue([[], 0]);

      await expect(service.hold(OTHER_USER, DEVICE_ID)).rejects.toThrow(
        NotFoundException,
      );
    });

    it("exposes the hold on the device list", async () => {
      subscriptionRepo.find.mockResolvedValue([
        storedDevice({ heldAt: new Date("2026-10-09T08:00:00Z") }),
        storedDevice({ id: "other" }),
      ]);

      const devices = await service.listForUser(USER);

      expect(devices[0].heldAt).toBe("2026-10-09T08:00:00.000Z");
      expect(devices[1].heldAt).toBeNull();
    });
  });

  describe("sendTest", () => {
    it("refuses when the instance has push switched off", async () => {
      pushConfig.getPublicConfig.mockResolvedValue({
        enabled: false,
        publicKey: null,
        configured: false,
      });

      await expect(service.sendTest(USER)).rejects.toThrow(BadRequestException);
      expect(sender.send).not.toHaveBeenCalled();
    });

    it("refuses, rather than reporting success over nothing, when no device is registered", async () => {
      subscriptionRepo.find.mockResolvedValue([]);

      await expect(service.sendTest(USER)).rejects.toThrow(BadRequestException);
      expect(sender.send).not.toHaveBeenCalled();
    });

    it("sends only to the caller's live devices", async () => {
      subscriptionRepo.find.mockResolvedValue([storedDevice()]);

      await service.sendTest(USER);

      const [[where]] = subscriptionRepo.find.mock.calls;
      expect(where.where.userId).toBe(USER);
      expect(where.where.disabledAt).toBeDefined();
      expect(sender.send).toHaveBeenCalledTimes(1);
    });

    // INV-PUSH-011: a signed-out device receives nothing, test sends included.
    it("skips held devices, and refuses when only held devices remain", async () => {
      subscriptionRepo.find.mockResolvedValue([]);

      await expect(service.sendTest(USER)).rejects.toThrow(BadRequestException);

      const [[query]] = subscriptionRepo.find.mock.calls;
      expect(query.where).toEqual({
        userId: USER,
        disabledAt: IsNull(),
        heldAt: IsNull(),
      });
      expect(sender.send).not.toHaveBeenCalled();
    });

    it("carries no financial detail across the push service", async () => {
      subscriptionRepo.find.mockResolvedValue([storedDevice()]);

      await service.sendTest(USER);

      const [, payload] = sender.send.mock.calls[0];
      // Pinned so a new field on the payload is a decision: everything here
      // crosses the push service and can reach a lock screen.
      expect(Object.keys(payload).sort()).toEqual([
        "body",
        "collapseKey",
        "target",
        "title",
        "type",
      ]);
      expect(payload.type).toBe("TEST");
      expect(payload.target.startsWith("/")).toBe(true);
      // "Push works here" is one subject, so two taps leave one notification
      // rather than two -- and there is no id to carry for it.
      expect(payload.collapseKey).toBeNull();
    });

    it("renders the body in the recipient's stored language", async () => {
      subscriptionRepo.find.mockResolvedValue([storedDevice()]);
      preferenceRepo.findOne.mockResolvedValue({ language: "pl" });
      const translate = jest.fn(
        (key: string) => `PL:${key}`,
      ) as unknown as I18nService["translate"];
      service = new PushSubscriptionService(
        dataSource as never,
        pushConfig as unknown as PushConfigService,
        sender as unknown as WebPushSender,
        { translate } as unknown as I18nService,
        charts as any,
      );

      await service.sendTest(USER);

      expect(translate).toHaveBeenCalledWith(
        "push.test.title",
        expect.objectContaining({ lang: "pl" }),
      );
      const [, payload] = sender.send.mock.calls[0];
      expect(payload.title).toBe("PL:push.test.title");
    });

    it("records a success by clearing the failure count", async () => {
      subscriptionRepo.find.mockResolvedValue([storedDevice()]);

      const result = await service.sendTest(USER);

      expect(result).toEqual({
        attempted: 1,
        delivered: 1,
        devices: [{ id: DEVICE_ID, deviceName: "Pixel 9", status: "sent" }],
      });
      const update = manager.query.mock.calls.find(([sql]) =>
        String(sql).includes("last_success_at"),
      )!;
      expect(update[0]).toContain("failure_count = 0");
      expect(update[1]).toEqual([DEVICE_ID, USER]);
    });

    it("retires a device the push service says is gone", async () => {
      subscriptionRepo.find.mockResolvedValue([storedDevice()]);
      sender.send.mockResolvedValue({
        status: "expired",
        reason: PushDisabledReason.GONE,
        statusCode: 410,
      });

      const result = await service.sendTest(USER);

      expect(result.delivered).toBe(0);
      expect(result.devices[0]).toEqual({
        id: DEVICE_ID,
        deviceName: "Pixel 9",
        status: "expired",
        disabledReason: PushDisabledReason.GONE,
      });
      const update = manager.query.mock.calls.find(([sql]) =>
        String(sql).includes("disabled_reason = $3"),
      )!;
      expect(update[1]).toEqual([DEVICE_ID, USER, PushDisabledReason.GONE]);
    });

    it("counts a transient failure without retiring the device", async () => {
      subscriptionRepo.find.mockResolvedValue([storedDevice()]);
      sender.send.mockResolvedValue({ status: "transient", message: "503" });
      manager.query.mockResolvedValue([
        [{ disabled_at: null, disabled_reason: null }],
        1,
      ]);

      const result = await service.sendTest(USER);

      expect(result.devices[0].status).toBe("transient");
      expect(result.devices[0].disabledReason).toBeUndefined();
      const update = manager.query.mock.calls.find(([sql]) =>
        String(sql).includes("failure_count = failure_count + 1"),
      )!;
      expect(update[1]).toEqual([
        DEVICE_ID,
        USER,
        MAX_CONSECUTIVE_FAILURES,
        PushDisabledReason.FAILING,
      ]);
    });

    // Two concurrent test sends can both hold one row. The device that has
    // already been retired as GONE must keep that reason: GONE and FAILING ask
    // the user for different repairs.
    it("does not relabel a device another send already retired", async () => {
      subscriptionRepo.find.mockResolvedValue([storedDevice()]);
      sender.send.mockResolvedValue({ status: "transient", message: "503" });
      manager.query.mockResolvedValue([[], 0]);

      const result = await service.sendTest(USER);

      expect(result.devices[0].disabledReason).toBeUndefined();
      const [sql] = manager.query.mock.calls.find(([s]) =>
        String(s).includes("failure_count = failure_count + 1"),
      )!;
      expect(sql).toContain("disabled_at IS NULL");
    });

    it("retires a device once the retry bound is reached", async () => {
      subscriptionRepo.find.mockResolvedValue([storedDevice()]);
      sender.send.mockResolvedValue({ status: "transient", message: "503" });
      manager.query.mockResolvedValue([
        [
          {
            disabled_at: new Date("2026-08-03T10:00:00Z"),
            disabled_reason: PushDisabledReason.FAILING,
          },
        ],
        1,
      ]);

      const result = await service.sendTest(USER);

      expect(result.devices[0].disabledReason).toBe(PushDisabledReason.FAILING);
    });

    it("writes no bookkeeping when the instance could not sign at all", async () => {
      subscriptionRepo.find.mockResolvedValue([storedDevice()]);
      sender.send.mockResolvedValue({ status: "unconfigured" });

      const result = await service.sendTest(USER);

      expect(result.delivered).toBe(0);
      expect(manager.query).not.toHaveBeenCalled();
    });

    // A failed delivery is reported, never raised: the notification must not be
    // able to undo whatever produced it.
    it("reports a per-device failure instead of throwing", async () => {
      subscriptionRepo.find.mockResolvedValue([
        storedDevice(),
        storedDevice({ id: "44444444-4444-4444-8444-444444444444" }),
      ]);
      sender.send
        .mockResolvedValueOnce({ status: "transient", message: "503" })
        .mockResolvedValueOnce({ status: "sent" });
      manager.query.mockResolvedValue([
        [{ disabled_at: null, disabled_reason: null }],
        1,
      ]);

      const result = await service.sendTest(USER);

      expect(result).toMatchObject({ attempted: 2, delivered: 1 });
      expect(result.devices.map((d) => d.status)).toEqual([
        "transient",
        "sent",
      ]);
    });
  });

  describe("sendToUser (the dispatch fan-out primitive)", () => {
    const payload = {
      type: "OVER_BUDGET",
      title: "t",
      body: "b",
      collapseKey: "k",
    };

    it("is a no-op, not a throw, when the channel is switched off", async () => {
      // The batch's identity is the one config read; not ready means disabled,
      // unconfigured or an unreadable key, and no device is even queried.
      sender.openBatch.mockResolvedValue({ ready: false, send });
      await expect(service.sendToUser(USER, payload as never)).resolves.toEqual(
        { attempted: 0, delivered: 0 },
      );
      expect(sender.send).not.toHaveBeenCalled();
      expect(subscriptionRepo.find).not.toHaveBeenCalled();
      expect(pushConfig.getPublicConfig).not.toHaveBeenCalled();
    });

    it("reads push_instance_config once per fan-out, through the batch", async () => {
      subscriptionRepo.find.mockResolvedValue([storedDevice()]);
      manager.query.mockResolvedValue([[{ id: DEVICE_ID }], 1]);
      await service.sendToUser(USER, payload as never);
      expect(sender.openBatch).toHaveBeenCalledTimes(1);
      expect(pushConfig.getPublicConfig).not.toHaveBeenCalled();
    });

    it("is a no-op when the user has no live device (never throws)", async () => {
      subscriptionRepo.find.mockResolvedValue([]);
      await expect(service.sendToUser(USER, payload as never)).resolves.toEqual(
        { attempted: 0, delivered: 0 },
      );
      expect(sender.send).not.toHaveBeenCalled();
    });

    it("never selects a held device (INV-PUSH-011)", async () => {
      await service.sendToUser(USER, payload as never);

      const [[query]] = subscriptionRepo.find.mock.calls;
      expect(query.where.heldAt).toEqual(IsNull());
      expect(query.where.disabledAt).toEqual(IsNull());
    });

    it("fans out to the caller's live devices with the given payload", async () => {
      subscriptionRepo.find.mockResolvedValue([storedDevice()]);
      manager.query.mockResolvedValue([[{ id: DEVICE_ID }], 1]);
      const result = await service.sendToUser(USER, payload as never);
      expect(sender.send).toHaveBeenCalledTimes(1);
      expect(sender.send.mock.calls[0][1]).toEqual(payload);
      expect(result).toEqual({ attempted: 1, delivered: 1 });
    });

    // Transport gating (spec section 15): the two push channels ride one wire and
    // differ only by which devices they reach, so the FILTER is the mechanism --
    // a user with `push` on and `unifiedpush` off must not be reached on a
    // UnifiedPush device. The dispatch spec proves the set it passes; these prove
    // the service applies it.
    it("narrows the device query to the transports the dispatch enabled", async () => {
      subscriptionRepo.find.mockResolvedValue([
        storedDevice({ transport: "unifiedpush" }),
      ]);
      await service.sendToUser(USER, payload as never, ["unifiedpush"]);
      expect(subscriptionRepo.find).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            userId: USER,
            transport: In(["unifiedpush"]),
          }),
        }),
      );
      expect(sender.send).toHaveBeenCalledTimes(1);
    });

    it("queries every wire when no filter is given (what sendTest wants)", async () => {
      subscriptionRepo.find.mockResolvedValue([storedDevice()]);
      await service.sendToUser(USER, payload as never);
      const where = subscriptionRepo.find.mock.calls[0][0].where;
      expect(where).not.toHaveProperty("transport");
    });

    it("an empty transport set sends nothing and never reaches the database", async () => {
      await expect(
        service.sendToUser(USER, payload as never, []),
      ).resolves.toEqual({ attempted: 0, delivered: 0 });
      expect(subscriptionRepo.find).not.toHaveBeenCalled();
      expect(sender.send).not.toHaveBeenCalled();
    });
  });

  describe("per-device chart fan-out", () => {
    const request = {
      securityId: "11111111-1111-4111-8111-111111111111",
      priceDate: "2026-09-02",
      price: 110,
    };
    const payload = {
      type: "SECURITY_PRICE_MOVEMENT",
      title: "Price",
      body: "Price changed",
      collapseKey: null,
    };
    afterEach(() => {
      charts.render.mockReset().mockResolvedValue(null);
      charts.issue.mockReset().mockResolvedValue(null);
    });
    it("renders once, issues separate webpush tokens and leaves UnifiedPush text-only", async () => {
      subscriptionRepo.find.mockResolvedValue([
        storedDevice({ transport: "webpush" }),
        storedDevice({ id: "device-2", transport: "webpush" }),
        storedDevice({ id: "device-3", transport: "unifiedpush" }),
      ]);
      charts.render.mockResolvedValue(Buffer.from("png"));
      charts.issue
        .mockResolvedValueOnce("/one.png")
        .mockResolvedValueOnce("/two.png");
      await service.sendToUser(USER, payload, undefined, request);
      expect(charts.render).toHaveBeenCalledTimes(1);
      expect(charts.render).toHaveBeenCalledWith(USER, request);
      const delivered = send.mock.calls.map((call) => call[1]);
      expect(
        delivered
          .filter((p) => p.image)
          .map((p) => p.image)
          .sort(),
      ).toEqual(["/one.png", "/two.png"]);
      expect(delivered.filter((p) => !p.image)).toEqual([payload]);
      expect(payload).not.toHaveProperty("image");
    });
    it("still delivers text when no artifact can be minted", async () => {
      subscriptionRepo.find.mockResolvedValue([
        storedDevice({ transport: "webpush" }),
      ]);
      charts.render.mockResolvedValue(Buffer.from("png"));
      await service.sendToUser(USER, payload, undefined, request);
      expect(send.mock.calls[0][1]).toEqual(payload);
    });
  });

  describe("bounding one test send", () => {
    function devices(count: number) {
      return Array.from({ length: count }, (_, i) =>
        storedDevice({ id: `d-${i}`, deviceName: `Device ${i}` }),
      );
    }

    // The per-send timeout bounds one delivery; this bounds the request. Sending
    // to the cap serially at that timeout would hold a request for the product
    // of the two, over hosts the account chose.
    it("talks to at most PUSH_TEST_CONCURRENCY devices at once", async () => {
      subscriptionRepo.find.mockResolvedValue(devices(10));
      let inFlight = 0;
      let peak = 0;
      sender.send.mockImplementation(async () => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await Promise.resolve();
        inFlight -= 1;
        return { status: "sent" };
      });

      const result = await service.sendTest(USER);

      expect(peak).toBeLessThanOrEqual(PUSH_TEST_CONCURRENCY);
      expect(result).toMatchObject({ attempted: 10, delivered: 10 });
    });

    it("reports every device exactly once, in order", async () => {
      subscriptionRepo.find.mockResolvedValue(devices(6));

      const result = await service.sendTest(USER);

      expect(result.devices.map((d) => d.id)).toEqual([
        "d-0",
        "d-1",
        "d-2",
        "d-3",
        "d-4",
        "d-5",
      ]);
    });
  });

  describe("a throttle is not a device's failure", () => {
    it("writes nothing at all for a throttled attempt", async () => {
      subscriptionRepo.find.mockResolvedValue([storedDevice()]);
      sender.send.mockResolvedValue({
        status: "transient",
        message: "Too Many Requests",
        statusCode: 429,
        throttled: true,
      });

      const result = await service.sendTest(USER);

      expect(result.devices[0].status).toBe("transient");
      expect(result.devices[0]).not.toHaveProperty("disabledReason");
      // Not the failure counter, and not `last_seen_at` either: neither claims
      // we heard anything about this device.
      const writes = manager.query.mock.calls.filter(([sql]) =>
        String(sql).includes("UPDATE push_subscriptions"),
      );
      expect(writes).toHaveLength(0);
    });

    it("still counts an ordinary transient failure", async () => {
      subscriptionRepo.find.mockResolvedValue([storedDevice()]);
      sender.send.mockResolvedValue({
        status: "transient",
        message: "socket hang up",
      });

      await service.sendTest(USER);

      const writes = manager.query.mock.calls.filter(([sql]) =>
        String(sql).includes("failure_count = failure_count + 1"),
      );
      expect(writes).toHaveLength(1);
    });
  });

  describe("the documented worst case for one test send", () => {
    // This number is what an operator sizes a gateway timeout against, so it is
    // composed from the parts rather than written down: it was derived from the
    // SOCKET timeout, which is an inactivity timer a host can reset forever, and
    // understated the real bound by a factor of nearly three.
    it("is composed from the re-check and the delivery deadline", () => {
      expect(PUSH_TEST_WORST_CASE_MS).toBe(
        Math.ceil(MAX_LIVE_DEVICES_PER_USER / PUSH_TEST_CONCURRENCY) *
          (PUSH_ENDPOINT_RECHECK_TIMEOUT_MS + PUSH_REQUEST_DEADLINE_MS),
      );
    });

    it("is bounded by the deadline, not by the inactivity timeout", () => {
      const fromInactivity =
        Math.ceil(MAX_LIVE_DEVICES_PER_USER / PUSH_TEST_CONCURRENCY) *
        (PUSH_ENDPOINT_RECHECK_TIMEOUT_MS + PUSH_REQUEST_TIMEOUT_MS);
      expect(PUSH_TEST_WORST_CASE_MS).toBeGreaterThan(fromInactivity);
    });
  });

  describe("purgeRetiredDevices", () => {
    it("deletes only rows retired past the retention window", async () => {
      manager.query.mockResolvedValue([[], 3]);

      await service.purgeRetiredDevices();

      const [sql, params] = manager.query.mock.calls[0];
      expect(String(sql)).toContain("DELETE FROM push_subscriptions");
      // Both halves matter: without the NOT NULL a live device is deleted, and
      // without the cutoff a device retired an hour ago vanishes before its
      // owner has seen why their phone went quiet.
      expect(String(sql)).toContain("disabled_at IS NOT NULL");
      expect(String(sql)).toContain("disabled_at < $1");
      const cutoff = (params as [Date])[0];
      const days = Math.round(
        (Date.now() - cutoff.getTime()) / (24 * 60 * 60 * 1000),
      );
      expect(days).toBe(RETIRED_DEVICE_RETENTION_DAYS);
    });

    it("deletes held rows only once the hold retention has passed", async () => {
      manager.query.mockResolvedValue([[], 0]);

      await service.purgeRetiredDevices();

      const held = manager.query.mock.calls.find(([sql]) =>
        String(sql).includes("held_at"),
      );
      expect(held).toBeDefined();
      const [sql, params] = held!;
      expect(String(sql)).toContain("DELETE FROM push_subscriptions");
      // Without the NOT NULL every signed-in device goes; without the cutoff a
      // device signed out an hour ago loses its resume.
      expect(String(sql)).toContain("held_at IS NOT NULL");
      expect(String(sql)).toContain("held_at < $1");
      const cutoff = (params as [Date])[0];
      const days = Math.round(
        (Date.now() - cutoff.getTime()) / (24 * 60 * 60 * 1000),
      );
      expect(days).toBe(HELD_DEVICE_RETENTION_DAYS);
    });

    // A cron has no request to inherit an identity from, so the real
    // `withScopedDb` throws unless the handler seeds one -- in every RLS_MODE,
    // including off.
    it("runs as a cross-user sweep under a system context", async () => {
      await service.purgeRetiredDevices();

      expect(withSystemContext).toHaveBeenCalledTimes(1);
    });

    // Housekeeping: a throw here is not worth taking the scheduler down for, and
    // the next run repeats the same idempotent DELETE.
    it("swallows a failure rather than escaping the cron", async () => {
      manager.query.mockRejectedValue(new Error("connection terminated"));

      await expect(service.purgeRetiredDevices()).resolves.toBeUndefined();
    });
  });

  describe("hashEndpoint", () => {
    it("is a stable 64-character digest, so the index can hold an unbounded URL", () => {
      expect(hashEndpoint(ENDPOINT)).toHaveLength(64);
      expect(hashEndpoint(ENDPOINT)).toBe(hashEndpoint(ENDPOINT));
      expect(hashEndpoint(ENDPOINT)).not.toBe(hashEndpoint(`${ENDPOINT}x`));
    });
  });
});
