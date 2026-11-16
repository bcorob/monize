import {
  MAX_WAITING_SETTLEMENTS,
  waitingSettlements,
} from "./waiting-settlements";

describe("waitingSettlements", () => {
  it("reads the settlements with a link row that waits for the value, newest first, user-scoped and unlocked", async () => {
    const query = jest.fn(async (_sql: string, _params?: unknown[]) => [
      { id: "s2", subject: "Newer", effective_date: "2026-01-10" },
      { id: "s1", subject: "Older", effective_date: "2025-12-20" },
    ]);

    const found = await waitingSettlements(
      { query } as never,
      "u1",
      "c1",
      "1000000002",
    );

    expect(found).toEqual([
      { id: "s2", subject: "Newer", effectiveDate: "2026-01-10" },
      { id: "s1", subject: "Older", effectiveDate: "2025-12-20" },
    ]);
    const [sql, params] = query.mock.calls[0];
    expect(sql).toContain("l.component_receipt_id IS NULL");
    expect(sql).toContain("s.user_id = $1");
    expect(sql).toContain("DESC");
    expect(sql).not.toContain("FOR UPDATE");
    expect(params).toEqual(["u1", "c1", "1000000002", MAX_WAITING_SETTLEMENTS]);
  });

  it("takes the limit the caller gives, and finds none when none wait", async () => {
    const query = jest.fn(async (_sql: string, _params?: unknown[]) => []);
    expect(
      await waitingSettlements({ query } as never, "u1", "c1", "k", 5),
    ).toEqual([]);
    expect(query.mock.calls[0][1]?.[3]).toBe(5);
  });
});
