import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { EntityManager } from "typeorm";
import { parseSchemaColumns } from "../common/db/raw-sql-columns";
import { BackupRestoreDatabaseService } from "./backup-restore-database.service";

// Use the shipped column list so the fixture cannot quietly retain the retired
// column after the migration removes it from real databases.
const columns = parseSchemaColumns(
  readFileSync(join(__dirname, "../../../database/schema.sql"), "utf8"),
).get("user_preferences")!;

describe("restoring preferences from before migration 188", () => {
  it.each([true, false])(
    "ignores the retired browser flag (%s) and preserves email",
    async (legacy) => {
      expect(columns.has("notification_browser")).toBe(false);
      const query = jest
        .fn()
        .mockResolvedValueOnce(
          [...columns].map((column_name) => ({
            column_name,
            data_type: "text",
            column_default: null,
          })),
        )
        .mockResolvedValue([]);
      const row = {
        user_id: "old-user",
        notification_email: false,
        notification_browser: legacy,
        language: "pl",
      };
      const service = new BackupRestoreDatabaseService();
      expect(
        await service.insertRows(
          { query } as unknown as EntityManager,
          "user_preferences",
          [row],
          "recipient",
        ),
      ).toBe(1);
      const [sql, values] = query.mock.calls[1] as [string, unknown[]];
      expect(sql).not.toContain('"notification_browser"');
      expect(sql).toContain('"notification_email"');
      expect(values).toEqual(["recipient", false, "pl"]);
      expect(row.user_id).toBe("old-user");
      expect(row.notification_browser).toBe(legacy);
    },
  );
});
