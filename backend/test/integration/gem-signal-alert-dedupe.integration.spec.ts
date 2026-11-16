import { DataSource } from "typeorm";
import { randomUUID } from "crypto";
import { withUserContext } from "@/common/db/with-context";
import { NotificationService } from "@/notification-center/notification.service";
import { buildGemSignalNotification } from "@/strategies/gem-signal-change-alert.service";
import {
  GemAssetRef,
  GemHistoryEntryView,
} from "@/strategies/gem-report.types";
import {
  cleanTables,
  createEnforcedIntegrationModule,
  createTestUserDirect,
  EnforcedIntegrationHarness,
} from "../helpers/integration-setup";

/**
 * The GEM signal-change alert's dedupe row outlives the retention purge
 * (A26-L24, INV-GEM-NOTIFY-002).
 *
 * The row keyed `gem:<strategy>:<period>:<kind>` is the only memory that a
 * period's change was announced. A quarterly period stays the current one for
 * three months, so a purge after the 30-day window used to let the next daily
 * run insert and send the same warning again. `gem:` is a state-keyed prefix
 * now: the purge keeps the row, and a re-run's insert is refused by the
 * partial unique index on `dedupe_key`.
 */
describe("GEM signal-change alert dedupe across the purge (integration)", () => {
  jest.setTimeout(180000);

  let harness: EnforcedIntegrationHarness;
  let owner: DataSource;
  let writeDoor: NotificationService;
  let userId: string;
  const STRATEGY_ID = randomUUID();

  const asset = (role: string, securityId: string): GemAssetRef =>
    ({ role, securityId, symbol: role, name: role }) as GemAssetRef;
  const period = (
    evaluatedOn: string,
    state: "RISK_ON" | "RISK_OFF",
    winner: GemAssetRef,
  ): GemHistoryEntryView =>
    ({ evaluatedOn, state, winner }) as unknown as GemHistoryEntryView;

  const input = () =>
    buildGemSignalNotification(
      { id: STRATEGY_ID, name: "Quarterly GEM" },
      {
        kind: "risk",
        current: period("2026-09-30", "RISK_OFF", asset("SAFE", "sec-safe")),
        previous: period("2026-06-30", "RISK_ON", asset("US_EQUITY", "sec-us")),
      },
    );

  const gemRows = async (): Promise<number> =>
    Number(
      (
        await owner.query(
          `SELECT COUNT(*)::int AS n FROM notifications WHERE dedupe_key LIKE 'gem:%'`,
        )
      )[0].n,
    );

  beforeAll(async () => {
    harness = await createEnforcedIntegrationModule([]);
    owner = harness.owner;
    writeDoor = new NotificationService(harness.app);
  });

  afterAll(async () => {
    await harness.close();
  });

  beforeEach(async () => {
    await cleanTables(owner, ["notifications", "users"]);
    userId = (await createTestUserDirect(owner)).id;
  });

  it("keeps a read alert past the retention window, so a re-run does not announce it again", async () => {
    expect(
      await withUserContext(userId, () => writeDoor.create(userId, input())),
    ).not.toBeNull();
    // Read on the 1st, now 40 days old: any other notification goes.
    await owner.query(
      `UPDATE notifications SET is_read = true, created_at = NOW() - INTERVAL '40 days'`,
    );

    await writeDoor.purgeOld();
    expect(await gemRows()).toBe(1);

    // The next daily run over the same current period.
    expect(
      await withUserContext(userId, () => writeDoor.create(userId, input())),
    ).toBeNull();
    expect(await gemRows()).toBe(1);
  });

  it("keeps a dismissed alert past the retention window too", async () => {
    await withUserContext(userId, () => writeDoor.create(userId, input()));
    await owner.query(
      `UPDATE notifications SET is_read = true, dismissed_at = NOW() - INTERVAL '31 days'`,
    );

    await writeDoor.purgeOld();

    expect(await gemRows()).toBe(1);
    expect(
      await withUserContext(userId, () => writeDoor.create(userId, input())),
    ).toBeNull();
  });
});
