import { ConflictException, NotFoundException } from "@nestjs/common";
import { DataSource } from "typeorm";
import { I18nService } from "nestjs-i18n";

import { withUserContext } from "@/common/db/with-context";
import { PushConfigService } from "@/push/push-config.service";
import { PushPriceChartService } from "@/push/push-price-chart.service";
import {
  HELD_DEVICE_RETENTION_DAYS,
  PushSubscriptionService,
} from "@/push/push-subscription.service";
import { PushBatch, WebPushSender } from "@/push/web-push-sender.service";

import {
  cleanTables,
  createEnforcedIntegrationModule,
  createTestUserDirect,
  EnforcedIntegrationHarness,
} from "../helpers/integration-setup";

/**
 * Holding a push device across a sign-out, against real PostgreSQL with RLS
 * enforced (INV-PUSH-011, issue #1630).
 *
 * Every property here is a claim about a guarded statement and the policy
 * behind it, which a mocked manager cannot answer: that another account can
 * neither hold nor lift a hold on a row it does not own, that only the owner's
 * re-registration clears it, that the fan-out's target query leaves a held row
 * out, and that the sweep's cutoff is the one the database applies.
 *
 * The service is built over the runtime role's connection with its outbound
 * collaborators stubbed: the sender records the endpoints a fan-out selected
 * and delivers nothing.
 */
describe("Push hold across a sign-out under RLS enforcement", () => {
  jest.setTimeout(180000);

  const PUBLIC_KEY = "integration-public-key";

  let harness: EnforcedIntegrationHarness;
  /** The table owner: seeds and inspects. Never the connection under test. */
  let db: DataSource;
  let service: PushSubscriptionService;
  let delivered: string[];

  let aliceId: string;
  let bobId: string;

  function subscription(endpoint: string) {
    return {
      endpoint,
      p256dh: "p256dh-value",
      auth: "auth-value",
      applicationServerKey: PUBLIC_KEY,
      deviceName: "Integration browser",
    };
  }

  async function heldAt(id: string): Promise<Date | null | undefined> {
    const [row] = await db.query(
      "SELECT held_at FROM push_subscriptions WHERE id = $1",
      [id],
    );
    return row ? row.held_at : undefined;
  }

  beforeAll(async () => {
    harness = await createEnforcedIntegrationModule([]);
    db = harness.owner;

    const pushConfig = {
      getPublicConfig: async () => ({
        enabled: true,
        configured: true,
        publicKey: PUBLIC_KEY,
      }),
    } as unknown as PushConfigService;
    const batch: PushBatch = {
      ready: true,
      send: async (target) => {
        delivered.push(target.endpoint);
        return { status: "sent" };
      },
    } as PushBatch;
    const sender = {
      openBatch: async () => batch,
    } as unknown as WebPushSender;
    const i18n = {
      translate: (key: string) => key,
    } as unknown as I18nService;
    const charts = {
      render: async () => null,
      issue: async () => null,
    } as unknown as PushPriceChartService;

    service = new PushSubscriptionService(
      harness.app,
      pushConfig,
      sender,
      i18n,
      charts,
    );
  });

  beforeEach(async () => {
    delivered = [];
    await cleanTables(db, ["push_subscriptions", "users"]);
    aliceId = (await createTestUserDirect(db, { firstName: "Alice" })).id;
    bobId = (await createTestUserDirect(db, { firstName: "Bob" })).id;
  });

  afterAll(async () => {
    await harness.close();
  });

  it("refuses another account's hold and leaves the owner's row deliverable", async () => {
    const endpoint = "https://push.example.test/alice-1";
    const device = await withUserContext(aliceId, () =>
      service.subscribe(aliceId, subscription(endpoint), null),
    );

    await expect(
      withUserContext(bobId, () => service.hold(bobId, device.id)),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(await heldAt(device.id)).toBeNull();
  });

  it("skips a held device on delivery and resumes it on the owner's re-registration", async () => {
    const endpoint = "https://push.example.test/alice-2";
    const device = await withUserContext(aliceId, () =>
      service.subscribe(aliceId, subscription(endpoint), null),
    );

    await withUserContext(aliceId, () => service.hold(aliceId, device.id));
    expect(await heldAt(device.id)).not.toBeNull();

    const whileHeld = await withUserContext(aliceId, () =>
      service.sendToUser(aliceId, {
        type: "TEST",
        title: "t",
        body: "b",
        target: "/",
        collapseKey: null,
      }),
    );
    expect(whileHeld).toEqual({ attempted: 0, delivered: 0 });
    expect(delivered).toEqual([]);

    const listed = await withUserContext(aliceId, () =>
      service.listForUser(aliceId),
    );
    expect(listed).toHaveLength(1);
    expect(listed[0].heldAt).not.toBeNull();

    const resumed = await withUserContext(aliceId, () =>
      service.subscribe(aliceId, subscription(endpoint), null),
    );
    expect(resumed.id).toBe(device.id);
    expect(resumed.heldAt).toBeNull();
    expect(await heldAt(device.id)).toBeNull();

    const afterResume = await withUserContext(aliceId, () =>
      service.sendToUser(aliceId, {
        type: "TEST",
        title: "t",
        body: "b",
        target: "/",
        collapseKey: null,
      }),
    );
    expect(afterResume).toEqual({ attempted: 1, delivered: 1 });
    expect(delivered).toEqual([endpoint]);
  });

  it("refuses another account's subscribe on a held endpoint and keeps the hold", async () => {
    const endpoint = "https://push.example.test/shared-browser";
    const device = await withUserContext(aliceId, () =>
      service.subscribe(aliceId, subscription(endpoint), null),
    );
    await withUserContext(aliceId, () => service.hold(aliceId, device.id));
    const before = await heldAt(device.id);

    await expect(
      withUserContext(bobId, () =>
        service.subscribe(bobId, subscription(endpoint), null),
      ),
    ).rejects.toBeInstanceOf(ConflictException);

    const [row] = await db.query(
      "SELECT user_id, held_at FROM push_subscriptions WHERE id = $1",
      [device.id],
    );
    expect(row.user_id).toBe(aliceId);
    expect(row.held_at).toEqual(before);
  });

  it("sweeps a hold past the retention window and keeps a younger one", async () => {
    const stale = await withUserContext(aliceId, () =>
      service.subscribe(
        aliceId,
        subscription("https://push.example.test/stale"),
        null,
      ),
    );
    const fresh = await withUserContext(aliceId, () =>
      service.subscribe(
        aliceId,
        subscription("https://push.example.test/fresh"),
        null,
      ),
    );
    await withUserContext(aliceId, async () => {
      await service.hold(aliceId, stale.id);
      await service.hold(aliceId, fresh.id);
    });
    await db.query(
      `UPDATE push_subscriptions
          SET held_at = CURRENT_TIMESTAMP - make_interval(days => $2)
        WHERE id = $1`,
      [stale.id, HELD_DEVICE_RETENTION_DAYS + 1],
    );

    await service.purgeRetiredDevices();

    const remaining = await db.query(
      "SELECT id FROM push_subscriptions ORDER BY id",
    );
    expect(remaining.map((r: { id: string }) => r.id)).toEqual([fresh.id]);
  });
});
