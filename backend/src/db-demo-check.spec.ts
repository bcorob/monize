import { Logger } from "@nestjs/common";

const mockQuery = jest.fn();
const mockConnect = jest.fn();
const mockEnd = jest.fn();

jest.mock("pg", () => ({
  Client: jest.fn().mockImplementation(() => ({
    connect: mockConnect,
    query: mockQuery,
    end: mockEnd,
  })),
}));

const mockExit = jest
  .spyOn(process, "exit")
  .mockImplementation((() => {}) as never);

import { checkDemoUser, demoUserExistsOn } from "./db-demo-check";
import { DB_LIFECYCLE_LOCK_KEY } from "./common/db/advisory-locks";

describe("db-demo-check", () => {
  let logSpy: jest.SpyInstance;
  let warnSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    mockConnect.mockResolvedValue(undefined);
    mockEnd.mockResolvedValue(undefined);
    logSpy = jest.spyOn(Logger.prototype, "log").mockImplementation();
    warnSpy = jest.spyOn(Logger.prototype, "warn").mockImplementation();
  });

  afterEach(() => {
    logSpy.mockRestore();
    warnSpy.mockRestore();
  });

  it("exits 0 when the demo user exists, so the entrypoint skips seeding", async () => {
    mockQuery.mockResolvedValue({ rows: [{ id: "demo-id" }] });

    await checkDemoUser();

    expect(mockQuery).toHaveBeenCalledWith(
      "SELECT id FROM users WHERE email = $1",
      ["demo@monize.com"],
    );
    expect(mockExit).toHaveBeenCalledWith(0);
    expect(logSpy).toHaveBeenCalledWith(
      "Demo user already exists; skipping seed",
    );
    expect(mockEnd).toHaveBeenCalled();
  });

  it("exits 1 when the demo user is absent, so the entrypoint seeds", async () => {
    mockQuery.mockResolvedValue({ rows: [] });

    await checkDemoUser();

    expect(mockExit).toHaveBeenCalledWith(1);
    expect(logSpy).toHaveBeenCalledWith(
      "Demo user not found; seeding demo data",
    );
  });

  it("exits 1 and warns when the check itself fails -- seeding is idempotent, an empty demo is not", async () => {
    mockConnect.mockRejectedValue(new Error("ECONNREFUSED"));

    await checkDemoUser();

    expect(mockExit).toHaveBeenCalledWith(1);
    expect(warnSpy.mock.calls[0][0]).toMatch(/ECONNREFUSED/);
  });

  it("closes the connection even when the query fails", async () => {
    mockQuery.mockRejectedValue(new Error("relation does not exist"));

    await checkDemoUser();

    expect(mockEnd).toHaveBeenCalled();
    expect(mockExit).toHaveBeenCalledWith(1);
  });

  // Two demo containers started together otherwise both read "no demo user"
  // and both seed. Waiting means the follower reads after the winner finished.
  it("takes the lifecycle lock before it reads", async () => {
    mockQuery.mockResolvedValue({ rows: [] });

    await checkDemoUser();

    const statements = mockQuery.mock.calls.map(([sql]) => sql as string);
    const lockAt = statements.findIndex((sql) =>
      sql.includes("pg_advisory_lock"),
    );
    const readAt = statements.findIndex((sql) => sql.includes("FROM users"));
    expect(lockAt).toBeGreaterThanOrEqual(0);
    expect(lockAt).toBeLessThan(readAt);
    expect(mockQuery.mock.calls[lockAt][1]).toEqual([DB_LIFECYCLE_LOCK_KEY]);
  });

  // The lock is session-scoped and dies with the connection, which is why the
  // seeder re-checks rather than trusting this probe's answer.
  it("releases the lock by closing its connection", async () => {
    mockQuery.mockResolvedValue({ rows: [] });

    await checkDemoUser();

    const statements = mockQuery.mock.calls.map(([sql]) => sql as string);
    expect(statements.some((sql) => sql.includes("pg_advisory_unlock"))).toBe(
      false,
    );
    expect(mockEnd).toHaveBeenCalled();
  });
});

describe("demoUserExistsOn", () => {
  // Separate from the connect-and-close wrapper so the seeder can ask on the
  // connection that holds the lock: a re-check on a second connection would be
  // answering about a moment the lock does not cover.
  it("asks on the caller's own connection", async () => {
    const query = jest.fn().mockResolvedValue({ rows: [{ id: "demo" }] });

    await expect(demoUserExistsOn({ query })).resolves.toBe(true);

    expect(query).toHaveBeenCalledWith(
      "SELECT id FROM users WHERE email = $1",
      ["demo@monize.com"],
    );
  });

  it("reports absence as false, not as an error", async () => {
    const query = jest.fn().mockResolvedValue({ rows: [] });

    await expect(demoUserExistsOn({ query })).resolves.toBe(false);
  });
});
