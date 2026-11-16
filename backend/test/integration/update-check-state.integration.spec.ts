import { DataSource } from "typeorm";
import { ConfigService } from "@nestjs/config";

import {
  UpdatesService,
  UPDATE_CHECK_WINDOW_MS,
} from "@/updates/updates.service";
import { withSystemContext } from "@/common/db/with-context";

import { INTEGRATION_TYPEORM_OPTIONS } from "../helpers/integration-setup";
import { applyRlsPolicies } from "../helpers/rls-setup";

/**
 * "GitHub is called once per twelve hours per deployment" is a property of the
 * conditional upsert, so it is tested against one.
 *
 * The claim and the freshness check are the same statement: the `DO UPDATE ...
 * WHERE` arm moves `checked_at` only when the stored one is older than the
 * window, and only the statement that moved it returns a row. Two replicas
 * ticking at the same instant therefore make one request -- which a read
 * followed by a write cannot promise, and which no mocked manager can
 * demonstrate (VER-001, `docs/verification-contract.md`). The race below runs
 * on **two separate connections** with `fetch` counted.
 */
describe("update check window (real PostgreSQL)", () => {
  let dataSourceA: DataSource;
  let dataSourceB: DataSource;
  let serviceA: UpdatesService;
  let serviceB: UpdatesService;
  let originalFetch: typeof fetch;
  let fetchCount: number;

  const RELEASE = {
    tag_name: "v99.0.0",
    name: "Monize 99.0.0",
    html_url: "https://example.test/releases/99",
    published_at: "2026-01-01T00:00:00Z",
    draft: false,
    prerelease: false,
  };

  const config = {
    get: () => undefined,
  } as unknown as ConfigService;

  beforeAll(async () => {
    dataSourceA = new DataSource(INTEGRATION_TYPEORM_OPTIONS as never);
    await dataSourceA.initialize();
    await applyRlsPolicies(dataSourceA);
    dataSourceB = new DataSource(INTEGRATION_TYPEORM_OPTIONS as never);
    await dataSourceB.initialize();

    // `onModuleInit` is never called here, so neither instance fires its own
    // startup refresh and every request below is one the spec asked for.
    serviceA = new UpdatesService(dataSourceA, config);
    serviceB = new UpdatesService(dataSourceB, config);
  });

  afterAll(async () => {
    if (dataSourceA?.isInitialized) await dataSourceA.destroy();
    if (dataSourceB?.isInitialized) await dataSourceB.destroy();
  });

  beforeEach(async () => {
    await dataSourceA.query("DELETE FROM update_check_state");
    fetchCount = 0;
    originalFetch = global.fetch;
    global.fetch = (async () => {
      fetchCount++;
      return {
        ok: true,
        status: 200,
        json: async () => RELEASE,
      } as unknown as Response;
    }) as unknown as typeof fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("makes one GitHub request when two replicas tick together", async () => {
    await Promise.all([
      serviceA.refreshLatestRelease(),
      serviceB.refreshLatestRelease(),
    ]);

    expect(fetchCount).toBe(1);

    const rows: unknown[] = await dataSourceA.query(
      "SELECT 1 FROM update_check_state",
    );
    expect(rows).toHaveLength(1);
  });

  it("asks nothing again inside the window", async () => {
    await serviceA.refreshLatestRelease();
    expect(fetchCount).toBe(1);

    // A restart, or the other replica's next tick.
    await serviceB.refreshLatestRelease();
    expect(fetchCount).toBe(1);
  });

  it("asks again once the window has passed", async () => {
    await serviceA.refreshLatestRelease();
    await dataSourceA.query(
      `UPDATE update_check_state
          SET checked_at = CURRENT_TIMESTAMP - ($1::bigint::text || ' milliseconds')::interval
        WHERE id = TRUE`,
      [UPDATE_CHECK_WINDOW_MS + 60_000],
    );

    await serviceB.refreshLatestRelease();

    expect(fetchCount).toBe(2);
  });

  // The reason the answer moved off a process field: the replica that never
  // fetched serves the same status as the one that did.
  it("answers identically from the replica that never fetched", async () => {
    await serviceA.refreshLatestRelease();

    const [fromA, fromB] = await withSystemContext(() =>
      Promise.all([serviceA.readLatestRelease(), serviceB.readLatestRelease()]),
    );

    expect(fromB).toEqual(fromA);
    expect(fromB.latestVersion).toBe("99.0.0");
    expect(fromB.releaseUrl).toBe(RELEASE.html_url);
  });

  it("keeps the last known version when a later check fails", async () => {
    await serviceA.refreshLatestRelease();
    await dataSourceA.query(
      `UPDATE update_check_state
          SET checked_at = CURRENT_TIMESTAMP - ($1::bigint::text || ' milliseconds')::interval
        WHERE id = TRUE`,
      [UPDATE_CHECK_WINDOW_MS + 60_000],
    );
    global.fetch = (async () => {
      throw new Error("ECONNRESET");
    }) as unknown as typeof fetch;

    await serviceB.refreshLatestRelease();

    const stored = await withSystemContext(() => serviceA.readLatestRelease());
    // "Cannot check" is not "nothing to install".
    expect(stored.latestVersion).toBe("99.0.0");
    expect(stored.error).toBe("unreachable");
  });

  it("holds the window after a failure, so the next tick does not re-ask", async () => {
    global.fetch = (async () => {
      throw new Error("ECONNRESET");
    }) as unknown as typeof fetch;

    await serviceA.refreshLatestRelease();
    await serviceB.refreshLatestRelease();

    const [row]: { checked_at: Date }[] = await dataSourceA.query(
      "SELECT checked_at FROM update_check_state",
    );
    expect(row.checked_at).toBeInstanceOf(Date);
    // An unreachable GitHub must not become a request from every replica on
    // every tick -- that is when the rate limit is least affordable.
    expect(Date.now() - row.checked_at.getTime()).toBeLessThan(60_000);
  });
});
