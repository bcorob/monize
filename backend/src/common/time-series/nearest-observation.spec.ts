import {
  nearestClosesFor,
  nearestObservation,
  nearestRatesFor,
} from "./nearest-observation";

/**
 * The approximation door of `docs/specs/account-balances-as-of.md` sections 4.2
 * and 7.2. Every case here is about the same thing: the answer is a real
 * observation, and it arrives with the date it was struck on so nobody can
 * present it as a measurement of the date asked about.
 */
describe("nearestObservation", () => {
  it("has no answer when nothing was ever observed", () => {
    expect(nearestObservation([], "2026-03-01")).toBeNull();
  });

  it("takes the closer neighbour whichever side of the date it is on", () => {
    const before = { date: "2025-11-14", value: 10 };
    const after = { date: "2026-03-20", value: 22 };
    expect(nearestObservation([before, after], "2026-03-01")).toEqual(after);
    expect(nearestObservation([before, after], "2025-12-01")).toEqual(before);
  });

  // A tie goes to the close that had already been struck when the date
  // arrived; the later one is a price the date could not have known.
  it("prefers the earlier observation on a tie, whatever order they arrive in", () => {
    const before = { date: "2026-02-01", value: 10 };
    const after = { date: "2026-03-29", value: 22 };
    expect(nearestObservation([before, after], "2026-03-01")).toEqual(before);
    expect(nearestObservation([after, before], "2026-03-01")).toEqual(before);
  });

  it("takes an observation struck on the date itself", () => {
    const exact = { date: "2026-03-01", value: 15 };
    expect(
      nearestObservation(
        [{ date: "2026-02-28", value: 9 }, exact],
        "2026-03-01",
      ),
    ).toEqual(exact);
  });
});

describe("nearestClosesFor", () => {
  const run = (rows: unknown[]) => ({
    query: jest.fn().mockResolvedValue(rows),
  });

  it("asks nothing of the database when no security is missing a price", async () => {
    const { query } = run([]);
    await expect(nearestClosesFor(query, [], "2026-03-01")).resolves.toEqual(
      new Map(),
    );
    expect(query).not.toHaveBeenCalled();
  });

  it("reduces each security's neighbours to the closest one, with its date", async () => {
    const { query } = run([
      { security_id: "sec-1", price_date: "2025-11-14", close_price: "10" },
      { security_id: "sec-1", price_date: "2026-03-20", close_price: "22" },
      { security_id: "sec-2", price_date: "2026-02-27", close_price: "5" },
    ]);
    const nearest = await nearestClosesFor(
      query,
      ["sec-1", "sec-2"],
      "2026-03-01",
    );
    expect(nearest.get("sec-1")).toEqual({ date: "2026-03-20", value: 22 });
    expect(nearest.get("sec-2")).toEqual({ date: "2026-02-27", value: 5 });
    expect(query.mock.calls[0][1]).toEqual([["sec-1", "sec-2"], "2026-03-01"]);
  });

  // A close of zero is a row that says nothing. Substituting it would report a
  // held position as worthless, which is worse than reporting it as unknown.
  it("treats a non-positive close as no observation at all", async () => {
    const { query } = run([
      { security_id: "sec-1", price_date: "2026-02-27", close_price: "0" },
      { security_id: "sec-1", price_date: "2025-01-05", close_price: "8" },
    ]);
    const nearest = await nearestClosesFor(query, ["sec-1"], "2026-03-01");
    expect(nearest.get("sec-1")).toEqual({ date: "2025-01-05", value: 8 });
  });

  it("has no entry for a security the database holds nothing for", async () => {
    const { query } = run([]);
    const nearest = await nearestClosesFor(query, ["sec-1"], "2026-03-01");
    expect(nearest.has("sec-1")).toBe(false);
  });
});

describe("nearestRatesFor", () => {
  const query = (rows: unknown[]) => jest.fn().mockResolvedValue(rows);

  it("asks nothing for a same-currency or empty pair list", async () => {
    const run = query([]);
    await nearestRatesFor(run, [{ from: "CAD", to: "CAD" }], "2026-03-01");
    expect(run).not.toHaveBeenCalled();
  });

  it("keys the closest rate by the direction it is stored in", async () => {
    const run = query([
      {
        stored_from: "USD",
        stored_to: "CAD",
        rate_date: "2024-05-01",
        rate: "1.35",
      },
    ]);
    const nearest = await nearestRatesFor(
      run,
      [{ from: "USD", to: "CAD" }],
      "2026-03-01",
    );
    expect(nearest.get("USD->CAD")).toEqual({
      date: "2024-05-01",
      value: 1.35,
    });
    expect(run.mock.calls[0][1]).toEqual([["USD"], ["CAD"], "2026-03-01"]);
  });

  // Two stored directions of one pair are two observations of it, and the
  // report converts with whichever observed the date more closely.
  it("takes the nearer of the two stored directions", async () => {
    const run = query([
      {
        stored_from: "USD",
        stored_to: "CAD",
        rate_date: "2020-01-02",
        rate: "1.3",
      },
      {
        stored_from: "CAD",
        stored_to: "USD",
        rate_date: "2026-02-01",
        rate: "0.8",
      },
    ]);
    const nearest = await nearestRatesFor(
      run,
      [{ from: "USD", to: "CAD" }],
      "2026-03-01",
    );
    expect([...nearest]).toEqual([
      ["CAD->USD", { date: "2026-02-01", value: 0.8 }],
    ]);
  });

  // Zero and negative are absent, not applicable -- the same reading
  // `convertWithRateLookup` gives them.
  it("treats a non-positive rate as no observation at all", async () => {
    const run = query([
      {
        stored_from: "USD",
        stored_to: "CAD",
        rate_date: "2026-02-27",
        rate: "0",
      },
    ]);
    const nearest = await nearestRatesFor(
      run,
      [{ from: "USD", to: "CAD" }],
      "2026-03-01",
    );
    expect(nearest.size).toBe(0);
  });
});
