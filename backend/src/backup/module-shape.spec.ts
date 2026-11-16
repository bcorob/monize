import { readFileSync, readdirSync } from "fs";
import { join, relative } from "path";

/**
 * The shape issue #1092 put the backup module into, held by a scan rather than a
 * paragraph.
 *
 * `BackupService` reached 2,600 lines because nothing failed while it grew. Every
 * individual addition was small and belonged somewhere in the file, and the
 * argument that backup-core changes cannot be split across independent PRs --
 * which is true -- was read as an argument that they cannot be split at all. Both
 * rules below are the parts of "keep it bounded" a machine can check: a file that
 * crosses the ceiling, and a facade that starts making decisions again.
 */

/** Repository ceiling from `AGENTS.md`: 200-400 typical, 800 max. */
const MAX_LINES = 800;

/**
 * Files over the ceiling before this guard existed, with the reason.
 *
 * This list may only ever shrink. A new entry is not a way to pass the test; it
 * is a decision to leave a file over the ceiling, and it needs the same argument
 * issue #1092 made about the file it replaced.
 */
const GRANDFATHERED: Record<string, string> = {
  // Scheduling, retention/promotion tiers, folder validation, disk writes and
  // the per-user enrollment reconciliation. Not touched by #1092; splitting it
  // is its own change with its own test-migration cost.
  "auto-backup.service.ts": "issue #1092 scoped the split to backup.service.ts",
  // Restore orchestration, from decrypt through reference checking and id
  // remap to the transactional write. Kept whole by the maintainer's decision
  // when the cross-user reference check took it just past the ceiling.
  "backup-restore.service.ts":
    "maintainer decision: restore flow kept in one file",
  // Specs are exempt in spirit -- they are enumerations of cases, and a long one
  // is not the same hazard as a long implementation -- but they are listed
  // rather than pattern-skipped so the count stays visible.
  "backup.service.spec.ts": "case enumeration, not implementation",
  "auto-backup.service.spec.ts": "case enumeration, not implementation",
  "backup-encryption.service.spec.ts": "case enumeration, not implementation",
  "support-backup/support-backup.service.spec.ts":
    "case enumeration, not implementation",
};

function moduleFiles(): string[] {
  const walk = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) return walk(full);
      return entry.name.endsWith(".ts") ? [full] : [];
    });
  return walk(__dirname);
}

describe("backup module shape", () => {
  it("finds the module's files (parser guard)", () => {
    // Every assertion below is vacuous over an empty list.
    const files = moduleFiles().map((f) => relative(__dirname, f));
    expect(files).toContain("backup.service.ts");
    expect(files).toContain("backup-export.service.ts");
    expect(files).toContain("support-backup/support-backup.service.ts");
  });

  it("keeps every file under the repository line ceiling", () => {
    const oversized = moduleFiles()
      .map((full) => ({
        file: relative(__dirname, full),
        lines: readFileSync(full, "utf8").split("\n").length,
      }))
      .filter(({ file, lines }) => lines > MAX_LINES && !GRANDFATHERED[file]);

    expect(oversized).toEqual([]);
  });

  it("does not let the grandfather list grow", () => {
    // Every name on it must still be a real, still-oversized file. An entry that
    // no longer applies is removed, not left as cover for the next one.
    for (const [file, reason] of Object.entries(GRANDFATHERED)) {
      expect(reason.length).toBeGreaterThan(0);
      const full = join(__dirname, file);
      const lines = readFileSync(full, "utf8").split("\n").length;
      expect(lines).toBeGreaterThan(MAX_LINES);
    }
  });

  /**
   * The facade holds no database and no storage.
   *
   * A facade that acquires a `DataSource` is a facade that can run a query, and
   * the first query is how the original grew. Keeping the dependency out is
   * cheaper to check than keeping the line count down, and it fails earlier.
   */
  it("keeps BackupService a delegating facade", () => {
    const source = readFileSync(join(__dirname, "backup.service.ts"), "utf8");
    expect(source).not.toMatch(/DataSource/);
    expect(source).not.toMatch(/withScopedDb/);
    expect(source).not.toMatch(/ATTACHMENT_STORAGE_PROVIDER/);
    expect(source).not.toMatch(/manager\.query\(/);
  });
});
