import {
  BackupData,
  LEGACY_TABLE_KEYS,
  backupTables,
  renameLegacyTableKeys,
} from "./backup-format";

/**
 * A backup keys its tables by SQL table name, so renaming a table renames a key
 * every artifact written before the rename does not carry.
 *
 * Nothing about that is loud: `insertRows` is handed `undefined` for the new
 * key, restores zero rows and reports zero -- silent data loss inside an
 * operation whose whole promise is that nothing is lost. The version cannot
 * carry the fix either, since `validateBackupFormat` compares it for equality
 * and bumping it would reject every existing artifact instead of reading one.
 */
function artifact(tables: Record<string, unknown[]>): BackupData {
  return {
    version: "1.0",
    exportedAt: "2026-08-30T00:00:00.000Z",
    ...tables,
  } as unknown as BackupData;
}

describe("renameLegacyTableKeys", () => {
  it("moves a legacy key onto the name the restore uses", () => {
    const data = artifact({ budget_alerts: [{ id: "n-1" }] });

    const result = renameLegacyTableKeys(data);
    expect(result).toMatchObject({
      renamed: ["budget_alerts -> notifications"],
      discarded: [],
    });
    const tables = backupTables(result.data);
    expect(tables.notifications).toEqual([{ id: "n-1" }]);
    // The old key is gone rather than left beside the new one: the insert path
    // is allowlisted by table name and would refuse it, and a reader finding
    // both cannot tell which one the restore used.
    expect("budget_alerts" in tables).toBe(false);
    // ...and the caller's document is untouched ("immutability always").
    expect(backupTables(data).budget_alerts).toEqual([{ id: "n-1" }]);
    expect("notifications" in backupTables(data)).toBe(false);
  });

  it("moves an empty table, because empty is not absent", () => {
    // A user with no notifications exports `[]`. Treating that as "no key" would
    // work by accident here and hide the rename for the next table, whose empty
    // case may not be harmless.
    const data = artifact({ budget_alerts: [] });

    const result = renameLegacyTableKeys(data);
    expect(result).toMatchObject({
      renamed: ["budget_alerts -> notifications"],
      discarded: [],
    });
    expect(backupTables(result.data).notifications).toEqual([]);
  });

  it("leaves a current artifact untouched and reports nothing moved", () => {
    const data = artifact({ notifications: [{ id: "n-1" }] });

    const result = renameLegacyTableKeys(data);
    expect(result).toMatchObject({ renamed: [], discarded: [] });
    expect(backupTables(result.data).notifications).toEqual([{ id: "n-1" }]);
  });

  it("keeps the current key when an artifact carries both", () => {
    // Written by an instance that already knew the new name, so the old key is
    // whatever it is -- not something to overwrite the real rows with.
    const data = artifact({
      budget_alerts: [{ id: "stale" }],
      notifications: [{ id: "n-1" }],
    });

    const result = renameLegacyTableKeys(data);

    const tables = backupTables(result.data);
    expect(tables.notifications).toEqual([{ id: "n-1" }]);
    expect("budget_alerts" in tables).toBe(false);
  });

  // Keeping the current key is the decision; being quiet about it is not part
  // of it. These rows are in the artifact and are not restored, and a restore
  // that says nothing about them reports a success it did not have.
  it("reports the rows it discarded when both keys carry data", () => {
    const data = artifact({
      budget_alerts: [{ id: "a" }, { id: "b" }],
      notifications: [{ id: "n-1" }],
    });

    expect(renameLegacyTableKeys(data)).toMatchObject({
      renamed: [],
      discarded: [
        { table: "budget_alerts", supersededBy: "notifications", rows: 2 },
      ],
    });
  });

  it("reports nothing when the discarded legacy table is empty", () => {
    // Nothing was lost, so there is nothing to warn about -- a warning per
    // restore of a perfectly ordinary artifact is how a real one gets ignored.
    const data = artifact({
      budget_alerts: [],
      notifications: [{ id: "n-1" }],
    });

    expect(renameLegacyTableKeys(data)).toMatchObject({
      renamed: [],
      discarded: [],
    });
  });

  it("does not invent a key for a table the artifact does not carry", () => {
    // A partial artifact (a support backup section, an older export) omits
    // tables entirely, and an empty array is a different claim from a missing
    // key: `insertRows` skips the second and truncates on the first.
    const data = artifact({ transactions: [] });

    expect(renameLegacyTableKeys(data)).toMatchObject({
      renamed: [],
      discarded: [],
    });
    expect("notifications" in backupTables(data)).toBe(false);
  });

  it("declares no alias for a name that is also a current table", () => {
    // An alias pointing at a live table would move real rows out of it. The
    // schema side of this is checked by migration-table-renames.spec.ts; this is
    // the shape check that needs no filesystem.
    for (const [current, legacyNames] of Object.entries(LEGACY_TABLE_KEYS)) {
      expect(legacyNames.length).toBeGreaterThan(0);
      expect(legacyNames).not.toContain(current);
      expect(new Set(legacyNames).size).toBe(legacyNames.length);
    }
  });
});
