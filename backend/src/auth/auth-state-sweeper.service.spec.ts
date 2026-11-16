import { DataSource } from "typeorm";

import { AuthStateSweeperService } from "./auth-state-sweeper.service";
import {
  createScopedDbMocks,
  DataSourceMock,
} from "../test-helpers/scoped-db-testing";

jest.mock("../common/db/scoped-db", () =>
  jest.requireActual("../test-helpers/scoped-db-testing").scopedDbMockModule(),
);

jest.mock("../common/db/with-context", () => ({
  withSystemContext: jest.fn((fn: () => unknown) => fn()),
}));

/**
 * What matters about a sweep is its predicate, so that is what these pin down.
 *
 * A sweep that took a JavaScript `Date` and passed it as a parameter would look
 * identical from the outside and be wrong in the way this codebase has been
 * wrong before: every replica holds its own clock, and the earliest one would
 * delete a counter another replica is still enforcing. The predicate is the
 * stored expiry against the database's `CURRENT_TIMESTAMP`, and the assertion
 * below is on that, not on a row count.
 */
describe("AuthStateSweeperService", () => {
  let service: AuthStateSweeperService;
  let manager: Record<string, jest.Mock>;
  let dataSource: DataSourceMock;

  beforeEach(() => {
    ({ dataSource, manager } = createScopedDbMocks([]));
    service = new AuthStateSweeperService(dataSource as unknown as DataSource);
  });

  afterEach(() => jest.restoreAllMocks());

  const statements = (): string[] =>
    manager.query.mock.calls.map((call) => String(call[0]));

  /** The instance's own Logger; it is a field, not a prototype member. */
  const spyOnLogger = (method: "log" | "warn"): jest.SpyInstance =>
    jest
      .spyOn(
        (service as unknown as { logger: Record<string, () => void> }).logger,
        method,
      )
      .mockImplementation();

  it("deletes all three tables by their stored expiry, with no clock of its own", async () => {
    manager.query.mockResolvedValue([[], 0]);

    await service.sweepExpiredAuthState();

    const [counters, tokens, throttles] = statements();
    expect(counters).toMatch(
      /DELETE FROM auth_attempt_counters\s+WHERE window_expires_at < CURRENT_TIMESTAMP/,
    );
    expect(tokens).toMatch(
      /DELETE FROM single_use_tokens\s+WHERE expires_at < CURRENT_TIMESTAMP/,
    );
    expect(throttles).toMatch(
      /DELETE FROM http_throttle_counters\s+WHERE window_expires_at < CURRENT_TIMESTAMP/,
    );
    // No bound parameters: a time this process computed is the defect above.
    for (const call of manager.query.mock.calls) {
      expect(call[1]).toBeUndefined();
    }
  });

  it("spares a throttle counter whose block outlives its window", async () => {
    manager.query.mockResolvedValue([[], 0]);

    await service.sweepExpiredAuthState();

    // A key past its window but still blocked is serving a refusal, and
    // deleting it would hand a blocked client a clean count -- the one way a
    // garbage collector could weaken a rate limit. The other two tables have no
    // equivalent state, which is why only this predicate carries the clause.
    const [, , throttles] = statements();
    expect(throttles).toMatch(
      /AND \(blocked_until IS NULL OR blocked_until < CURRENT_TIMESTAMP\)/,
    );
  });

  it("sweeps all three tables in one transaction", async () => {
    manager.query.mockResolvedValue([[], 0]);

    await service.sweepExpiredAuthState();

    expect(dataSource.transaction).toHaveBeenCalledTimes(1);
    expect(statements()).toHaveLength(3);
  });

  it("logs what it removed only when it removed something", async () => {
    const log = spyOnLogger("log");

    manager.query.mockResolvedValue([[], 0]);
    await service.sweepExpiredAuthState();
    expect(log).not.toHaveBeenCalled();

    // The `[rows, rowCount]` tuple a data-modifying query really returns, which
    // is the shape `affectedRowCount` exists to read: `result.length` on it is
    // always 2, so a naive reading would report two rows swept on every run.
    manager.query.mockResolvedValue([[], 3]);
    await service.sweepExpiredAuthState();
    expect(log).toHaveBeenCalledWith(
      "Swept 3 expired attempt counter(s), 3 expired single-use token(s) and " +
        "3 expired throttle counter(s)",
    );
  });

  it("logs when only the throttle counters had anything to remove", async () => {
    // Each table is swept whether or not the others found rows, and a run that
    // collected only throttle counters still reports it -- the `> 0` test is on
    // the three together, so a per-table one would have gone silent here.
    const log = spyOnLogger("log");
    manager.query
      .mockResolvedValueOnce([[], 0])
      .mockResolvedValueOnce([[], 0])
      .mockResolvedValueOnce([[], 5]);

    await service.sweepExpiredAuthState();

    expect(log).toHaveBeenCalledWith(
      "Swept 0 expired attempt counter(s), 0 expired single-use token(s) and " +
        "5 expired throttle counter(s)",
    );
  });

  it("warns and swallows a failure instead of rejecting out of the cron", async () => {
    const warn = spyOnLogger("warn");
    manager.query.mockRejectedValue(new Error("connection reset"));

    await expect(service.sweepExpiredAuthState()).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith(
      "Auth state sweep failed: connection reset",
    );
  });
});
