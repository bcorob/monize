import type { EntityManager } from "typeorm";
import { BackupRestoreDatabaseService } from "./backup-restore-database.service";
import {
  boundRestoredNotification,
  validateRestoredNotifications,
} from "./notification-restore-bounds";
import {
  TITLE_MAX_LENGTH,
  TARGET_MAX_LENGTH,
  DEDUPE_KEY_MAX_LENGTH,
} from "../notification-center/notification-bounds";

const logger = { warn: jest.fn(), error: jest.fn() };

describe("notification restore bounds (INV-NOTIFY-001)", () => {
  it("bounds the actual dynamic INSERT, keeping archive identity and data", async () => {
    const row = {
      id: "archive-id",
      user_id: "old-user",
      alert_type: "BILL_DUE",
      title: "t".repeat(TITLE_MAX_LENGTH + 30),
      dedupe_key: "k".repeat(DEDUPE_KEY_MAX_LENGTH + 30),
      target: "/" + "x".repeat(TARGET_MAX_LENGTH),
      created_at: "2026-01-01T00:00:00Z",
      period_start: "2026-01-01",
      message: "Original message",
      data: { name: "Original name" },
    };
    const query = jest
      .fn()
      .mockResolvedValueOnce(
        Object.keys(row).map((column_name) => ({
          column_name,
          data_type: "text",
          column_default: null,
        })),
      )
      .mockResolvedValue([]);
    const service = new BackupRestoreDatabaseService();
    await service.insertRows(
      { query } as unknown as EntityManager,
      "notifications",
      [row],
      "recipient",
    );
    const [sql, values] = query.mock.calls[1] as [string, unknown[]];
    expect(sql).toContain('INSERT INTO "notifications"');
    expect(sql).toContain("ON CONFLICT DO NOTHING");
    expect(values).toEqual([
      "archive-id",
      "recipient",
      "BILL_DUE",
      "t".repeat(TITLE_MAX_LENGTH - 1) + "…",
      "k".repeat(DEDUPE_KEY_MAX_LENGTH),
      null,
      row.created_at,
      row.period_start,
      row.message,
      JSON.stringify(row.data),
    ]);
    expect(row.title).toHaveLength(TITLE_MAX_LENGTH + 30);
    expect(row.user_id).toBe("old-user");
  });

  it("preserves valid and absent optional fields, and is idempotent", () => {
    for (const fields of [
      {},
      { target: null, dedupe_key: null },
      { target: "/bills", dedupe_key: "key" },
      {
        target: "/" + "x".repeat(TARGET_MAX_LENGTH - 1),
        dedupe_key: "k".repeat(DEDUPE_KEY_MAX_LENGTH),
      },
    ]) {
      const row = { title: "t".repeat(TITLE_MAX_LENGTH), ...fields };
      const bounded = boundRestoredNotification(row, logger);
      expect(bounded).toEqual(row);
      expect(boundRestoredNotification(bounded, logger)).toEqual(bounded);
    }
  });

  it.each([
    null,
    {},
    "rows",
    [null],
    [{ title: null }],
    [{ title: 12 }],
    [{ title: "ok", target: {} }],
    [{ title: "ok", dedupe_key: 42 }],
  ])("rejects malformed fields: %j", (rows) => {
    expect(() => validateRestoredNotifications(rows)).toThrow(
      "Invalid backup notification",
    );
  });

  it("accepts backups predating notifications and empty tables", () => {
    expect(() => validateRestoredNotifications(undefined)).not.toThrow();
    expect(() => validateRestoredNotifications([])).not.toThrow();
  });
});
