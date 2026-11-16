import { DataSource } from "typeorm";

import { AiWriteLimiter } from "@/ai/actions/ai-write-limiter";
import { AuthAttemptCounterService } from "@/auth/auth-attempt-counter.service";
import { withUserContext } from "@/common/db/with-context";
import {
  McpWriteLimiter,
  MCP_DAILY_WRITE_LIMIT,
} from "@/mcp/mcp-write-limiter";

import { INTEGRATION_TYPEORM_OPTIONS } from "../helpers/integration-setup";
import { applyRlsPolicies } from "../helpers/rls-setup";

/**
 * The daily LLM write cap is one count per user per surface for the whole
 * deployment, not one per replica.
 *
 * What it replaced was an array per process, so N replicas granted N times the
 * cap and a rollout reset it. The property that fixes that -- two processes
 * incrementing one row, and each reading the other's writes -- belongs to
 * PostgreSQL, so the two limiters below sit on **two separate connection
 * pools** (VER-001, `docs/verification-contract.md`). A mocked counter could be
 * told to return any sequence and would prove nothing about it.
 */
describe("Daily LLM write limit (real PostgreSQL)", () => {
  let dataSourceA: DataSource;
  let dataSourceB: DataSource;
  let countersA: AuthAttemptCounterService;
  let countersB: AuthAttemptCounterService;
  let mcpA: McpWriteLimiter;
  let mcpB: McpWriteLimiter;

  const USER = "33333333-3333-4333-8333-333333333333";
  const asUser = <T>(fn: () => Promise<T>) => withUserContext(USER, fn);

  beforeAll(async () => {
    dataSourceA = new DataSource(INTEGRATION_TYPEORM_OPTIONS as never);
    await dataSourceA.initialize();
    await applyRlsPolicies(dataSourceA);
    // A second DataSource is a second pool: the closest one test process gets
    // to a second replica.
    dataSourceB = new DataSource(INTEGRATION_TYPEORM_OPTIONS as never);
    await dataSourceB.initialize();

    countersA = new AuthAttemptCounterService(dataSourceA);
    countersB = new AuthAttemptCounterService(dataSourceB);
    mcpA = new McpWriteLimiter(countersA);
    mcpB = new McpWriteLimiter(countersB);
  });

  afterAll(async () => {
    if (dataSourceA?.isInitialized) await dataSourceA.destroy();
    if (dataSourceB?.isInitialized) await dataSourceB.destroy();
  });

  beforeEach(async () => {
    await dataSourceA.query(
      "DELETE FROM auth_attempt_counters WHERE scope IN ('mcp-write', 'ai-write')",
    );
  });

  it("counts one user's writes on either replica against one row", async () => {
    await asUser(() => mcpA.record(USER, "create_transaction"));
    await asUser(() => mcpB.record(USER, "create_payee", 2));

    const rows: { count: number | string }[] = await dataSourceA.query(
      "SELECT count FROM auth_attempt_counters WHERE scope = 'mcp-write' AND key = $1",
      [USER],
    );
    expect(rows).toHaveLength(1);
    expect(Number(rows[0].count)).toBe(3);
  });

  it("loses no write when both replicas record at once", async () => {
    const spyA = jest.spyOn(countersA, "incrementUntilUtcMidnight");
    const spyB = jest.spyOn(countersB, "incrementUntilUtcMidnight");
    try {
      await asUser(() =>
        Promise.all([
          mcpA.record(USER, "create_transaction", 5),
          mcpB.record(USER, "create_transaction", 5),
          mcpA.record(USER, "create_payee", 5),
          mcpB.record(USER, "create_payee", 5),
        ]),
      );

      // One statement per record, each adding its five, and every one
      // returned a distinct running total: had any statement read the count
      // and written it back, two would share a number and the row would hold
      // fewer than twenty.
      const returned = await Promise.all(
        [...spyA.mock.results, ...spyB.mock.results].map(
          (r) => r.value as Promise<{ count: number }>,
        ),
      );
      expect(returned.map((r) => r.count).sort((a, b) => a - b)).toEqual([
        5, 10, 15, 20,
      ]);
    } finally {
      spyA.mockRestore();
      spyB.mockRestore();
    }

    await expect(asUser(() => mcpB.checkLimit(USER))).resolves.toEqual({
      allowed: true,
      currentCount: 20,
      limit: MCP_DAILY_WRITE_LIMIT,
    });
  });

  it("refuses on replica B once replica A has spent the day", async () => {
    await asUser(() =>
      mcpA.record(USER, "create_transaction", MCP_DAILY_WRITE_LIMIT - 1),
    );

    // B never recorded anything; the budget it reads is the row's.
    await expect(asUser(() => mcpB.reserve(USER, 1))).resolves.toBeUndefined();
    const refused = await asUser(() => mcpB.reserve(USER, 2));
    expect(refused?.isError).toBe(true);

    await asUser(() => mcpA.record(USER, "create_transaction"));
    await expect(asUser(() => mcpB.checkLimit(USER))).resolves.toMatchObject({
      allowed: false,
      currentCount: MCP_DAILY_WRITE_LIMIT,
    });
  });

  it("keeps the AI Assistant's budget separate from MCP's for one user", async () => {
    const ai = new AiWriteLimiter(countersB);
    await asUser(() => mcpA.record(USER, "create_transaction", 4));
    await asUser(() => ai.record(USER, "create_transaction", 1));

    await expect(asUser(() => ai.checkLimit(USER))).resolves.toMatchObject({
      currentCount: 1,
    });
    await expect(asUser(() => mcpB.checkLimit(USER))).resolves.toMatchObject({
      currentCount: 4,
    });
  });

  it("ends the window at the next UTC midnight, stamped by the first write", async () => {
    await asUser(() => mcpA.record(USER, "create_transaction"));
    await asUser(() => mcpB.record(USER, "create_transaction"));

    const [row]: { expires: Date | string }[] = await dataSourceA.query(
      `SELECT window_expires_at AS expires
         FROM auth_attempt_counters
        WHERE scope = 'mcp-write' AND key = $1`,
      [USER],
    );
    // Exactly the database's next UTC midnight: the boundary is computed in
    // SQL from the database clock, so no replica's clock can move it.
    const [db]: { midnight: Date | string }[] = await dataSourceA.query(
      `SELECT (date_trunc('day', now() AT TIME ZONE 'UTC') + interval '1 day')
                AT TIME ZONE 'UTC' AS midnight`,
    );
    expect(new Date(row.expires).getTime()).toBe(
      new Date(db.midnight).getTime(),
    );
  });

  it("starts a new day at zero once the window has passed", async () => {
    await asUser(() => mcpA.record(USER, "create_transaction", 3));
    await dataSourceA.query(
      `UPDATE auth_attempt_counters
          SET window_expires_at = CURRENT_TIMESTAMP - INTERVAL '1 second'
        WHERE scope = 'mcp-write' AND key = $1`,
      [USER],
    );

    await expect(asUser(() => mcpB.checkLimit(USER))).resolves.toMatchObject({
      currentCount: 0,
      allowed: true,
    });
    await asUser(() => mcpB.record(USER, "create_transaction"));
    await expect(asUser(() => mcpA.checkLimit(USER))).resolves.toMatchObject({
      currentCount: 1,
    });
  });
});
