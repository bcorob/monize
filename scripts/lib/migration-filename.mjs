/**
 * The migration-filename grammar and comparator, for the repository scripts.
 *
 * There is one definition -- `backend/src/common/db/migration-filename.ts`,
 * which the runner and the test harnesses import -- and the scripts load that
 * same file rather than carrying a copy: Node strips the types on import
 * (22.18+ / 24, the versions the Dockerfile and CI pin), and the file is kept
 * free of syntax that would need a compiler.
 *
 * Node reports the first ESM-syntax `.ts` file it meets under a package.json
 * with no `"type"` as MODULE_TYPELESS_PACKAGE_JSON, advising `"type": "module"`
 * in `backend/package.json` -- which would switch every backend file to ESM.
 * The backend is CommonJS by design, so that advice is wrong here and the one
 * warning is filtered out below. Every other warning is forwarded to Node's
 * own printer unchanged; nothing is silenced but this code.
 *
 * Import from here, never from the `.ts` file directly:
 * `migration-filename.spec.ts` fails a second direct import.
 */

const printers = process.listeners("warning");
process.removeAllListeners("warning");
process.on("warning", (warning) => {
  if (warning.code === "MODULE_TYPELESS_PACKAGE_JSON") return;
  for (const print of printers) print(warning);
});

const helper =
  await import("../../backend/src/common/db/migration-filename.ts");

export const {
  LEGACY_PREFIX_CEILING,
  LEGACY_PREFIX_WIDTH,
  TIMESTAMP_PREFIX_WIDTH,
  TIMESTAMP_SCHEME_ADOPTED,
  compareMigrationFilenames,
  orderMigrations,
  parseMigrationPrefix,
  timestampPrefixFor,
  timestampPrefixToDate,
} = helper;
