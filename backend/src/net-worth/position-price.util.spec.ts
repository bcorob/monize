import { positionCloseAsOf, PricePoint } from "./position-price.util";

/**
 * The as-of merge for issue #1242. The invariant under test: the accepted price
 * store (security_prices) is authoritative for valuation regardless of a
 * security's skipPriceUpdates flag; the legacy transaction fallback is merged
 * chronologically (newest observation wins, the store wins on an equal date),
 * so a stored series that only begins mid-window does not suppress the legacy
 * history that values its earlier dates (review MZ-1242-R1); and no observation
 * after the sample date is ever used.
 */
describe("positionCloseAsOf", () => {
  const stored: PricePoint[] = [
    { date: "2024-06-01", close: 61 },
    { date: "2026-07-31", close: 100 },
    { date: "2026-08-20", close: 120 },
  ];

  it("uses the latest accepted stored close on or before the date", () => {
    expect(positionCloseAsOf(stored, undefined, "2026-08-20")).toBe(120);
    expect(positionCloseAsOf(stored, undefined, "2026-08-25")).toBe(120);
  });

  it("does not leak a future observation backward", () => {
    // 2026-08-01 sits between the 2026-07-31 ($100) and 2026-08-20 ($120) rows.
    expect(positionCloseAsOf(stored, undefined, "2026-08-01")).toBe(100);
    // Before the first observation there is nothing to carry forward.
    expect(positionCloseAsOf(stored, undefined, "2024-01-01")).toBeNull();
  });

  it("prefers the accepted store over a transaction-derived fallback", () => {
    // Same-day: the store holds a manual $120 correction while the transaction
    // implied $61. The store wins; the fallback is never consulted.
    const tx: PricePoint[] = [{ date: "2026-08-20", close: 61 }];
    expect(positionCloseAsOf(stored, tx, "2026-08-20")).toBe(120);
  });

  it("falls back to transaction prices when the store has no row", () => {
    const tx: PricePoint[] = [
      { date: "2024-01-10", close: 50 },
      { date: "2024-03-10", close: 55 },
    ];
    expect(positionCloseAsOf(undefined, tx, "2024-02-01")).toBe(50);
    expect(positionCloseAsOf([], tx, "2024-05-01")).toBe(55);
    // The fallback also respects the as-of boundary.
    expect(positionCloseAsOf(undefined, tx, "2023-12-31")).toBeNull();
  });

  // MZ-1242-R1: a legacy restore can leave a security with only a *future*
  // stored observation (a manual price added after the restore) while its
  // pre-restore history lives only in investment_transactions. Suppressing the
  // fallback because "a stored row exists" reported those earlier dates as $0.
  it("uses legacy history before the first accepted stored observation", () => {
    const storedFuture: PricePoint[] = [{ date: "2025-03-01", close: 80 }];
    const tx: PricePoint[] = [{ date: "2024-01-15", close: 50 }];
    expect(positionCloseAsOf(storedFuture, tx, "2024-12-31")).toBe(50);
  });

  it("uses a newer legacy observation after an older stored observation", () => {
    const storedOld: PricePoint[] = [{ date: "2025-01-01", close: 80 }];
    const tx: PricePoint[] = [{ date: "2025-06-01", close: 90 }];
    expect(positionCloseAsOf(storedOld, tx, "2025-06-30")).toBe(90);
  });

  it("keeps accepted stored precedence when both sources share the date", () => {
    const storedSameDay: PricePoint[] = [{ date: "2025-06-01", close: 120 }];
    const tx: PricePoint[] = [{ date: "2025-06-01", close: 61 }];
    expect(positionCloseAsOf(storedSameDay, tx, "2025-06-01")).toBe(120);
  });

  it("returns null when neither source can answer", () => {
    expect(positionCloseAsOf(undefined, undefined, "2026-01-01")).toBeNull();
    expect(positionCloseAsOf([], [], "2026-01-01")).toBeNull();
  });
});
