import { orderByDateStable } from "./date-order.util";

/**
 * The one ordering every import path feeds its rows to the rules in
 * (INV-RULE-005): by date, and within a date in the source's order, with the
 * row's place in the source kept beside it.
 */
describe("orderByDateStable", () => {
  const row = (date: string, label: string) => ({ date, label });

  it("orders by date ascending and keeps the source order within a date", () => {
    const ordered = orderByDateStable(
      [
        row("2024-03-01", "march"),
        row("2024-01-05", "january first"),
        row("2024-01-05", "january second"),
        row("2024-02-01", "february"),
      ],
      (r) => r.date,
    );
    expect(ordered.map(({ row: r }) => r.label)).toEqual([
      "january first",
      "january second",
      "february",
      "march",
    ]);
  });

  it("keeps each row's 1-based place in the source", () => {
    const ordered = orderByDateStable(
      [row("2024-03-01", "a"), row("2024-01-05", "b")],
      (r) => r.date,
    );
    expect(ordered.map(({ row: r, position }) => [r.label, position])).toEqual([
      ["b", 2],
      ["a", 1],
    ]);
  });

  it("leaves a source already in date order exactly as it was, and does not touch the input", () => {
    const rows = [
      row("2024-01-01", "a"),
      row("2024-01-01", "b"),
      row("2024-01-02", "c"),
    ];
    const ordered = orderByDateStable(rows, (r) => r.date);
    expect(ordered.map(({ row: r }) => r)).toEqual(rows);
    expect(rows.map((r) => r.label)).toEqual(["a", "b", "c"]);
    expect(orderByDateStable([], (r: { date: string }) => r.date)).toEqual([]);
  });
});
