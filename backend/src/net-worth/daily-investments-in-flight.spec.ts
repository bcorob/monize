import { EntityManager } from "typeorm";
import { runWithActiveScopedManager } from "../common/db/scoped-db";
import { requestContextStorage } from "../common/request-context";
import {
  invalidateAllPortfolioSummaries,
  invalidatePortfolioSummary,
  applyPortfolioSummaryInvalidation,
} from "../securities/portfolio-summary-memo";
import {
  DailyInvestmentsKeyInput,
  buildDailyInvestmentsKey,
  dailyInvestmentsInFlight,
} from "./daily-investments-in-flight";

const USER = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";

const input = (
  overrides: Partial<DailyInvestmentsKeyInput> = {},
): DailyInvestmentsKeyInput => ({
  userId: USER,
  startDate: "1998-09-30",
  endDate: "2026-10-27",
  accountIds: undefined,
  currency: "GBP",
  collectPositions: false,
  fetchMissing: undefined,
  ...overrides,
});

/** A computation the test settles by hand. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const asUser = <T>(userId: string, fn: () => T): T =>
  requestContextStorage.run({ userId }, fn);

describe("dailyInvestmentsInFlight (#1888)", () => {
  afterEach(() => dailyInvestmentsInFlight.clearAll());

  it("shares one running valuation between identical callers", async () => {
    const work = deferred<string>();
    const compute = jest.fn(() => work.promise);

    const first = dailyInvestmentsInFlight.run(USER, "k", compute);
    const second = dailyInvestmentsInFlight.run(USER, "k", compute);
    work.resolve("series");

    await expect(first).resolves.toBe("series");
    await expect(second).resolves.toBe("series");
    expect(compute).toHaveBeenCalledTimes(1);
  });

  it("never answers from a finished valuation", async () => {
    const compute = jest.fn(async () => "series");

    await dailyInvestmentsInFlight.run(USER, "k", compute);
    await dailyInvestmentsInFlight.run(USER, "k", compute);

    expect(compute).toHaveBeenCalledTimes(2);
    expect(dailyInvestmentsInFlight.size).toBe(0);
  });

  it("passes a failure to every caller and forgets it", async () => {
    const work = deferred<string>();
    const first = dailyInvestmentsInFlight.run(USER, "k", () => work.promise);
    const second = dailyInvestmentsInFlight.run(USER, "k", () => work.promise);
    work.reject(new Error("boom"));

    await expect(first).rejects.toThrow("boom");
    await expect(second).rejects.toThrow("boom");
    expect(dailyInvestmentsInFlight.size).toBe(0);
  });

  it("never shares with a caller inside a transaction", async () => {
    const work = deferred<string>();
    void dailyInvestmentsInFlight.run(USER, "k", () => work.promise);
    const inside = jest.fn(async () => "uncommitted");

    const answer = await runWithActiveScopedManager({} as EntityManager, () =>
      dailyInvestmentsInFlight.run(USER, "k", inside),
    );

    expect(answer).toBe("uncommitted");
    expect(inside).toHaveBeenCalledTimes(1);
    work.resolve("series");
  });

  it.each([
    ["invalidatePortfolioSummary", () => invalidatePortfolioSummary(USER)],
    [
      "invalidateAllPortfolioSummaries",
      () => invalidateAllPortfolioSummaries(),
    ],
    [
      "a replica's invalidation",
      () => applyPortfolioSummaryInvalidation({ userId: USER }),
    ],
  ])(
    "a read after %s starts its own valuation instead of joining the earlier one",
    async (_name, invalidate) => {
      const before = deferred<string>();
      const stale = dailyInvestmentsInFlight.run(
        USER,
        "k",
        () => before.promise,
      );
      invalidate();
      const fresh = jest.fn(async () => "after the write");

      await expect(
        dailyInvestmentsInFlight.run(USER, "k", fresh),
      ).resolves.toBe("after the write");
      expect(fresh).toHaveBeenCalledTimes(1);
      before.resolve("before the write");
      await expect(stale).resolves.toBe("before the write");
    },
  );

  it("an invalidation for one user leaves another user's valuation shared", async () => {
    const work = deferred<string>();
    void dailyInvestmentsInFlight.run(OTHER, "other", () => work.promise);

    invalidatePortfolioSummary(USER);

    expect(dailyInvestmentsInFlight.size).toBe(1);
    work.resolve("series");
  });

  describe("buildDailyInvestmentsKey", () => {
    it("is the same for the same question, whatever the account order", () => {
      expect(
        asUser(USER, () =>
          buildDailyInvestmentsKey(input({ accountIds: ["b", "a"] })),
        ),
      ).toBe(
        asUser(USER, () =>
          buildDailyInvestmentsKey(input({ accountIds: ["a", "b"] })),
        ),
      );
    });

    it.each<[string, Partial<DailyInvestmentsKeyInput>]>([
      ["the start", { startDate: "2020-01-01" }],
      ["an open start", { startDate: undefined }],
      ["the end", { endDate: "2026-10-26" }],
      ["the scope", { accountIds: ["a"] }],
      ["the currency", { currency: "USD" }],
      ["collecting positions", { collectPositions: true }],
      ["the stored-rates-only opt-out", { fetchMissing: false }],
    ])("differs by %s", (_name, overrides) => {
      expect(
        asUser(USER, () => buildDailyInvestmentsKey(input(overrides))),
      ).not.toBe(asUser(USER, () => buildDailyInvestmentsKey(input())));
    });

    it("differs by the identity the reads run under", () => {
      const owner = asUser(USER, () => buildDailyInvestmentsKey(input()));
      const delegate = requestContextStorage.run(
        { userId: USER, realUserId: OTHER },
        () => buildDailyInvestmentsKey(input()),
      );
      expect(delegate).not.toBe(owner);
    });

    it("differs by the request timezone", () => {
      const toronto = requestContextStorage.run(
        { userId: USER, timezone: "America/Toronto" },
        () => buildDailyInvestmentsKey(input()),
      );
      const london = requestContextStorage.run(
        { userId: USER, timezone: "Europe/London" },
        () => buildDailyInvestmentsKey(input()),
      );
      expect(toronto).not.toBe(london);
    });
  });
});
