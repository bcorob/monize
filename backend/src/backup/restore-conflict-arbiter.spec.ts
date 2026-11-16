import type { EntityManager } from "typeorm";
import { BackupRestoreDatabaseService } from "./backup-restore-database.service";

/**
 * PostgreSQL refuses a bare `ON CONFLICT DO NOTHING` on a table with a
 * DEFERRABLE unique constraint, which aborted every restore of a backup that
 * carried a transaction rule. The insert names the primary key for those
 * tables (`CONFLICT_ARBITER_COLUMNS`) and stays bare for every other one.
 */
async function insertSql(table: string, row: Record<string, unknown>) {
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
  await new BackupRestoreDatabaseService().insertRows(
    { query } as unknown as EntityManager,
    table,
    [row],
    "restoring-user",
  );
  return (query.mock.calls[1] as [string, unknown[]])[0];
}

describe("restore insert conflict arbiter", () => {
  it("names the primary key for a table with a deferrable unique constraint", async () => {
    const sql = await insertSql("transaction_rules", {
      id: "rule-id",
      user_id: "old-user",
      name: "Rule",
      position: 0,
    });
    expect(sql).toContain('INSERT INTO "transaction_rules"');
    expect(sql).toContain('ON CONFLICT ("id") DO NOTHING');
  });

  it("keeps the bare form for every other table", async () => {
    const sql = await insertSql("tags", {
      id: "tag-id",
      user_id: "old-user",
      name: "Tag",
    });
    expect(sql).toMatch(/ON CONFLICT DO NOTHING/);
  });
});
