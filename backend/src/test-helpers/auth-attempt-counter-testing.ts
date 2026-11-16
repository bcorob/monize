import {
  AttemptWindow,
  AuthAttemptCounterService,
} from "../auth/auth-attempt-counter.service";

/**
 * An `AuthAttemptCounterService` double backed by a `Map`.
 *
 * The limiter it replaces *is* the behaviour several auth specs assert ("three
 * wrong codes and the fourth is refused before verification"), so a double that
 * only records calls would take those assertions with it. This one reproduces
 * the statement's semantics instead: count up inside the window, reset to 1 once
 * the window has passed, delete on `reset`. Typed as `jest.Mocked<...>` so `tsc`
 * rejects a shape the real service cannot return.
 *
 * The map is in the *test*, not in the code under test, which is the whole
 * point: it stands in for one shared table, so a spec can also drive the loser
 * path by pre-seeding a count.
 */
export type AuthAttemptCounterMock = jest.Mocked<
  Pick<
    AuthAttemptCounterService,
    "increment" | "incrementUntilUtcMidnight" | "peek" | "reset"
  >
> & {
  /** The rows, keyed `scope\u0000key`, for a spec that wants to seed or inspect one. */
  rows: Map<string, { count: number; windowExpiresAt: Date }>;
};

function rowKey(scope: string, key: string): string {
  return `${scope}\u0000${key}`;
}

export function createAuthAttemptCounterMock(): AuthAttemptCounterMock {
  const rows = new Map<string, { count: number; windowExpiresAt: Date }>();

  const mock: AuthAttemptCounterMock = {
    rows,
    increment: jest.fn(
      async (
        scope: string,
        key: string,
        windowMs: number,
        window: AttemptWindow,
      ) => {
        const id = rowKey(scope, key);
        const existing = rows.get(id);
        const now = Date.now();
        // `window` is honoured here for the same reason the map exists: a double
        // that always kept the first window would make every caller look fixed,
        // and the specs that assert a lockout accumulating would pass against a
        // limiter that never locks.
        const next =
          !existing || existing.windowExpiresAt.getTime() < now
            ? { count: 1, windowExpiresAt: new Date(now + windowMs) }
            : {
                count: existing.count + 1,
                windowExpiresAt:
                  window === "sliding"
                    ? new Date(now + windowMs)
                    : existing.windowExpiresAt,
              };
        rows.set(id, next);
        return next;
      },
    ),
    // The daily-budget variant: add `by`, window ending at the next UTC
    // midnight (computed here from the fake clock, as the database computes it
    // from its own), reset in place once that midnight has passed.
    incrementUntilUtcMidnight: jest.fn(
      async (scope: string, key: string, by: number) => {
        const id = rowKey(scope, key);
        const existing = rows.get(id);
        const now = new Date();
        const midnight = new Date(
          Date.UTC(
            now.getUTCFullYear(),
            now.getUTCMonth(),
            now.getUTCDate() + 1,
          ),
        );
        const next =
          !existing || existing.windowExpiresAt.getTime() < now.getTime()
            ? { count: by, windowExpiresAt: midnight }
            : {
                count: existing.count + by,
                windowExpiresAt: existing.windowExpiresAt,
              };
        rows.set(id, next);
        return next;
      },
    ),
    peek: jest.fn(async (scope: string, key: string) => {
      const row = rows.get(rowKey(scope, key));
      if (!row || row.windowExpiresAt.getTime() < Date.now()) return 0;
      return row.count;
    }),
    reset: jest.fn(async (scope: string, key: string) => {
      rows.delete(rowKey(scope, key));
    }),
  };
  return mock;
}

/** Provider entry for `Test.createTestingModule({ providers: [...] })`. */
export function authAttemptCounterProvider(
  mock: AuthAttemptCounterMock = createAuthAttemptCounterMock(),
): {
  provide: typeof AuthAttemptCounterService;
  useValue: AuthAttemptCounterMock;
} {
  return { provide: AuthAttemptCounterService, useValue: mock };
}
