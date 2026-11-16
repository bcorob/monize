import {
  DAILY_PRICE_GAP_EXCLUSION_DAYS,
  DAILY_PRICE_STALE_AFTER_DAYS,
  keepNewestSession,
  priceDateYmd,
  resolveDailyPriceChange,
} from "./daily-change.util";

/**
 * The two rules a pair of closes has to pass to be a daily move, and the
 * boundary of each. The staleness rule is the one this file was written for: a
 * security whose feed goes quiet keeps its last two closes forever, and every
 * surface reading them reported that last move as today's, every day, until a
 * new price arrived.
 */
describe("resolveDailyPriceChange", () => {
  const TODAY = "2026-02-09";
  const points = (
    current: [string, number],
    previous: [string, number],
  ): Array<{ price: number; date: string }> => [
    { date: current[0], price: current[1] },
    { date: previous[0], price: previous[1] },
  ];

  it("reports the move between two adjacent, current sessions", () => {
    const change = resolveDailyPriceChange(
      points(["2026-02-09", 110], ["2026-02-06", 100]),
      TODAY,
    );

    expect(change).toEqual({
      currentPrice: 110,
      previousPrice: 100,
      dailyChange: 10,
      dailyChangePercent: 10,
      priceDate: "2026-02-09",
    });
  });

  it("refuses a pair whose newest close is no longer the current session", () => {
    // The defect: no price row landed for this security for a week, so its two
    // most recent closes are still last Monday's and the Friday before it --
    // a real move, but not today's, and not one a "daily change" may show.
    expect(
      resolveDailyPriceChange(
        points(["2026-02-02", 110], ["2026-02-01", 100]),
        TODAY,
      ),
    ).toBeNull();
  });

  it("keeps a close old enough only for a holiday weekend", () => {
    // Thursday's close read on the Monday of a Good Friday weekend: four days,
    // and the most recent session there is.
    const change = resolveDailyPriceChange(
      points(["2026-02-05", 110], ["2026-02-04", 100]),
      TODAY,
    );

    expect(change?.priceDate).toBe("2026-02-05");
  });

  it("refuses one day past that, where a feed has stopped rather than paused", () => {
    expect(
      resolveDailyPriceChange(
        points(["2026-02-04", 110], ["2026-02-03", 100]),
        TODAY,
      ),
    ).toBeNull();
    // The boundary is the constant, not a number typed twice.
    expect(DAILY_PRICE_STALE_AFTER_DAYS).toBe(5);
  });

  it("treats a close dated ahead of the reader's own day as current", () => {
    // An Asian session prints while a reader west of it is still on the
    // previous date. Negative age is not staleness.
    const change = resolveDailyPriceChange(
      points(["2026-02-10", 110], ["2026-02-09", 100]),
      TODAY,
    );

    expect(change?.dailyChange).toBe(10);
  });

  it("refuses two closes that are not adjacent sessions", () => {
    // A weekly-priced fund, and the GIC case: a real move over a real period,
    // but not a day's.
    expect(
      resolveDailyPriceChange(
        points(["2026-02-09", 50000], ["2025-02-10", 80000]),
        TODAY,
      ),
    ).toBeNull();
    expect(
      resolveDailyPriceChange(
        points(["2026-02-09", 110], ["2026-02-02", 100]),
        TODAY,
      ),
    ).toBeNull();
    expect(DAILY_PRICE_GAP_EXCLUSION_DAYS).toBe(7);
  });

  it("allows the longest gap that is still one session apart", () => {
    // Six days: a fund priced on the Monday before a week of closures. Seven
    // is the weekly-priced fund, which is not a daily move.
    expect(
      resolveDailyPriceChange(
        points(["2026-02-09", 110], ["2026-02-03", 100]),
        TODAY,
      )?.dailyChange,
    ).toBe(10);
  });

  it("refuses a pair it cannot make a percentage from", () => {
    expect(
      resolveDailyPriceChange(
        points(["2026-02-09", 110], ["2026-02-06", 0]),
        TODAY,
      ),
    ).toBeNull();
    expect(
      resolveDailyPriceChange([{ date: "2026-02-09", price: 110 }], TODAY),
    ).toBeNull();
    expect(resolveDailyPriceChange([], TODAY)).toBeNull();
    expect(resolveDailyPriceChange(undefined, TODAY)).toBeNull();
  });

  it("reports a security that held its price as a zero move, not as unknown", () => {
    // Zero and unknown are different facts: this security traded and did not
    // move, which is exactly what its row should say.
    const change = resolveDailyPriceChange(
      points(["2026-02-09", 110], ["2026-02-06", 110]),
      TODAY,
    );

    expect(change?.dailyChange).toBe(0);
    expect(change?.dailyChangePercent).toBe(0);
  });

  it("reads a date column whether it arrives as a string or as a Date", () => {
    // `pg` hands a `date` back either way depending on the parsers installed,
    // and a local-midnight Date read as UTC is a day out for half the world.
    expect(priceDateYmd("2026-02-09")).toBe("2026-02-09");
    expect(priceDateYmd("2026-02-09T00:00:00.000Z")).toBe("2026-02-09");
    expect(priceDateYmd(new Date(2026, 1, 9))).toBe("2026-02-09");

    const change = resolveDailyPriceChange(
      [
        { date: new Date(2026, 1, 9), price: 110 },
        { date: new Date(2026, 1, 6), price: 100 },
      ],
      TODAY,
    );
    expect(change?.priceDate).toBe("2026-02-09");
  });

  it("refuses a date it cannot read rather than guessing at its age", () => {
    expect(
      resolveDailyPriceChange(points(["", 110], ["2026-02-06", 100]), TODAY),
    ).toBeNull();
  });
});

/**
 * The rule the age test cannot carry on its own: a feed that skips one symbol
 * and a market that was shut leave the same day-old close behind, and only the
 * rest of the board says which happened.
 */
describe("keepNewestSession", () => {
  const row = (symbol: string, priceDate: string) => ({ symbol, priceDate });

  it("drops a holding that did not price while the others did", () => {
    // The defect: this holding's last move is Monday's, a real move of a day
    // that is over, and it outranked every holding that actually moved today.
    expect(
      keepNewestSession([
        row("XMU", "2026-02-09"),
        row("ZGI", "2026-02-10"),
        row("XPF", "2026-02-10"),
      ]),
    ).toEqual([row("ZGI", "2026-02-10"), row("XPF", "2026-02-10")]);
  });

  it("keeps every row when no holding priced today, so a weekend has a board", () => {
    // Nothing is stale here relative to anything else: Friday's session is the
    // newest there is, and Friday's board is the honest one to show.
    const friday = [row("XMU", "2026-02-06"), row("ZGI", "2026-02-06")];

    expect(keepNewestSession(friday)).toEqual(friday);
  });

  it("keeps a lone holding, whose own session is the newest there is", () => {
    expect(keepNewestSession([row("XMU", "2026-02-06")])).toEqual([
      row("XMU", "2026-02-06"),
    ]);
  });

  it("orders by day rather than by the text of a date", () => {
    // A year boundary and a month boundary: YYYY-MM-DD compares as text in the
    // order it compares as days, and nothing else here relies on that.
    expect(
      keepNewestSession([
        row("A", "2025-12-31"),
        row("B", "2026-01-01"),
        row("C", "2026-09-02"),
        row("D", "2026-09-10"),
      ]),
    ).toEqual([row("D", "2026-09-10")]);
  });

  it("has nothing to show for an empty board", () => {
    expect(keepNewestSession([])).toEqual([]);
  });

  it("leaves the board it was given alone", () => {
    // The caller sorts what comes back; a helper that filtered in place would
    // take rows off the list the caller still holds.
    const rows = [row("XMU", "2026-02-09"), row("ZGI", "2026-02-10")];

    keepNewestSession(rows);

    expect(rows).toEqual([row("XMU", "2026-02-09"), row("ZGI", "2026-02-10")]);
  });
});
