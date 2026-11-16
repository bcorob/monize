#!/usr/bin/env node
// Verify migration filename prefixes are unique, well-formed, and -- for any
// migration this branch adds -- timestamp-prefixed.
//
// `database/CLAUDE.md` states the rules in prose. Prose did not stop this from
// happening: a remediation branch added `133_import_jobs_one_active_per_user.sql`
// while `main` had meanwhile taken `133` for `133_joint_account_grants.sql`, and
// later four review passes landing within nine hours of each other used `165`
// and `166` twice each (issue #1277). Migrations are applied and tracked **by
// full filename**, so on a database that had already recorded the other file,
// the newly introduced one would be seen as pending and applied *after* it --
// with the apply order between two same-prefix files decided by alphabetical
// tie-breaking. Two authors branching from the same base both correctly read
// "the current max is 164" and both correctly pick 165; nothing either can do
// locally detects the other, because this check runs per branch and sees one
// side of the collision at a time.
//
// So a new migration no longer takes a counter. It takes the UTC second it was
// authored, `YYYYMMDDHHMMSS_description.sql` (`date -u +%Y%m%d%H%M%S`): two
// authors cannot generate the same second, so a collision is not policed but
// unavailable. The three-digit files are historical and never renumbered
// (`schema_migrations` keys on the filename; a rename re-runs the body on every
// deployed database), and apply order is numeric on the prefix everywhere
// migrations are ordered -- `backend/src/common/db/migration-filename.ts`,
// which this script imports, is that one definition.
//
// Three checks:
//
//   1. no numeric prefix is used twice, except the historical pairs below;
//   2. every filename carries one of the two forms, every timestamp names a
//      real UTC instant between the scheme's adoption and now, and no
//      three-digit prefix exceeds the highest the retired scheme issued;
//   3. when a base ref is available, every migration this branch adds is
//      timestamp-prefixed, and every migration on the base still exists.
//
// Check 3 needs git history. It reports and skips rather than failing when the
// base ref is absent (shallow clone, detached build), because a check that
// cannot run must not look like a check that passed. Check 2's ceiling on
// three-digit prefixes is what still catches a new sequential file then.
//
// Requires Node 22.18+ / 24 (`scripts/lib/migration-filename.mjs` loads the
// backend's TypeScript definition through type stripping) and, for check 3, git.

import { readdirSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  LEGACY_PREFIX_CEILING,
  TIMESTAMP_SCHEME_ADOPTED,
  compareMigrationFilenames,
  parseMigrationPrefix,
  timestampPrefixFor,
  timestampPrefixToDate,
} from "./lib/migration-filename.mjs";

// `.pathname` on a file:// URL is percent-encoded (a space becomes `%20`) and
// `fs` wants a real OS path, not a URL component -- `fileURLToPath` decodes it.
// A repo checked out under a path with a space (not exotic: "My Drive", "Moje
// glupoty") reads that literal `%20` as a directory name and ENOENTs on the
// very first `readdirSync`.
const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const MIGRATIONS = join(REPO_ROOT, "database", "migrations");

/**
 * Prefixes already shared by two files when this check was written. Every one
 * predates the rule and is recorded in `database/CLAUDE.md`. **This list may
 * only shrink** -- adding to it is choosing the ambiguous apply order the check
 * exists to prevent.
 */
const GRANDFATHERED_DUPLICATES = new Set([
  "022",
  "068",
  "075",
  "116",
  "117",
  "124",
]);

/**
 * How far ahead of this machine's clock a timestamp may sit before it is a
 * typo rather than clock skew. A migration dated next year would apply last on
 * every fresh install while already-migrated databases ran it today.
 */
const FUTURE_TOLERANCE_MS = 24 * 60 * 60 * 1000;

/** Base refs tried, in order, for the "added migrations are timestamped" check. */
const BASE_REFS = ["origin/main", "main"];

const HOW_TO_NAME =
  "Name a new migration YYYYMMDDHHMMSS_description.sql, using the UTC time of " +
  "authoring (`date -u +%Y%m%d%H%M%S`).";

const failures = [];
const notes = [];

function migrationNames(list) {
  return list.filter((name) => name.endsWith(".sql"));
}

/**
 * Apply order for the report, falling back to plain string order for a name
 * the comparator refuses -- that name is itself a finding below, and the
 * report still has to list it.
 */
function reportOrder(a, b) {
  if (parseMigrationPrefix(a) && parseMigrationPrefix(b)) {
    return compareMigrationFilenames(a, b);
  }
  return a < b ? -1 : a > b ? 1 : 0;
}

// ---------------------------------------------------------------------------
// Check 1: unique numeric prefixes
// ---------------------------------------------------------------------------

const names = migrationNames(readdirSync(MIGRATIONS)).sort(reportOrder);

if (names.length === 0) {
  failures.push(
    "database/migrations contains no .sql files -- the check would be vacuous",
  );
}

const byPrefix = new Map();
const parsed = new Map();
for (const name of names) {
  const prefix = parseMigrationPrefix(name);
  if (!prefix) {
    failures.push(
      `${name}: filename carries neither a historical NNN_ prefix nor a ` +
        `YYYYMMDDHHMMSS_ prefix. ${HOW_TO_NAME}`,
    );
    continue;
  }
  parsed.set(name, prefix);
  byPrefix.set(prefix.text, [...(byPrefix.get(prefix.text) ?? []), name]);
}

const staleGrandfathers = [];
for (const prefix of GRANDFATHERED_DUPLICATES) {
  if ((byPrefix.get(prefix) ?? []).length < 2) staleGrandfathers.push(prefix);
}
if (staleGrandfathers.length) {
  // The list may only shrink, so a prefix that is no longer duplicated must be
  // removed from it -- otherwise it silently re-permits a future collision.
  failures.push(
    `GRANDFATHERED_DUPLICATES lists prefixes that are no longer duplicated: ` +
      `${staleGrandfathers.join(", ")}. Remove them from ${"scripts/check-migration-prefixes.mjs"}.`,
  );
}

for (const [prefix, files] of byPrefix) {
  if (files.length > 1 && !GRANDFATHERED_DUPLICATES.has(prefix)) {
    failures.push(
      `duplicate migration prefix ${prefix}: ${files.join(", ")} -- ` +
        `apply order falls back to alphabetical tie-breaking. ${HOW_TO_NAME}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Check 2: every prefix is well-formed for its scheme
// ---------------------------------------------------------------------------

const now = Date.now();

for (const [name, prefix] of parsed) {
  if (prefix.kind === "legacy") {
    if (prefix.value > LEGACY_PREFIX_CEILING) {
      failures.push(
        `${name}: sequential prefix ${prefix.text} is above ${LEGACY_PREFIX_CEILING}, the highest ` +
          `the retired NNN_ scheme ever issued, so this is a new migration named under ` +
          `that scheme. ${HOW_TO_NAME}`,
      );
    }
    continue;
  }
  const instant = timestampPrefixToDate(prefix.text);
  if (!instant) {
    failures.push(
      `${name}: ${prefix.text} is not a real UTC date and time (YYYYMMDDHHMMSS).`,
    );
    continue;
  }
  if (prefix.value < TIMESTAMP_SCHEME_ADOPTED) {
    failures.push(
      `${name}: timestamp ${prefix.text} predates the adoption of timestamp prefixes ` +
        `(${TIMESTAMP_SCHEME_ADOPTED}); check the year. ${HOW_TO_NAME}`,
    );
    continue;
  }
  if (instant.getTime() > now + FUTURE_TOLERANCE_MS) {
    failures.push(
      `${name}: timestamp ${prefix.text} is more than a day in the future ` +
        `(now is ${timestampPrefixFor(new Date(now))} UTC). A future-dated migration ` +
        `applies last on every fresh install while upgraded databases ran it today. ${HOW_TO_NAME}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Check 3: what this branch adds is timestamped; what the base has, it keeps
// ---------------------------------------------------------------------------

function git(args) {
  return execFileSync("git", args, {
    cwd: REPO_ROOT,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
}

function resolveBase() {
  for (const ref of BASE_REFS) {
    try {
      git(["rev-parse", "--verify", `${ref}^{commit}`]);
      return ref;
    } catch {
      continue;
    }
  }
  return null;
}

/**
 * The commit this branch diverged from, not the base ref's tip: a branch that
 * has not merged main since main gained a migration has not *removed* that
 * migration, and comparing against the tip would say it had. On a pull-request
 * checkout (the merge ref) HEAD already contains main, so the merge-base is
 * main's tip; on main itself it is HEAD. Falls back to the ref when git cannot
 * compute one (a detached build with no shared history).
 */
function comparisonPoint(ref) {
  try {
    return git(["merge-base", ref, "HEAD"]);
  } catch {
    return ref;
  }
}

const baseRef = existsSync(join(REPO_ROOT, ".git")) ? resolveBase() : null;
const base = baseRef ? comparisonPoint(baseRef) : null;

if (!base) {
  notes.push(
    'no base ref (origin/main or main) resolved, so the "added migrations are ' +
      'timestamp-prefixed" check did not run. Prefix uniqueness and well-formedness ' +
      `were still verified, including that no sequential prefix exceeds ${LEGACY_PREFIX_CEILING}.`,
  );
} else {
  let baseNames = [];
  try {
    baseNames = migrationNames(
      git(["ls-tree", "--name-only", base, "database/migrations/"]).split("\n"),
    ).map((path) => path.replace(/^database\/migrations\//, ""));
  } catch {
    notes.push(
      `could not list database/migrations at ${baseRef} (${base}); skipped the branch comparison.`,
    );
  }

  if (baseNames.length > 0) {
    const baseSet = new Set(baseNames);
    const branchSet = new Set(names);
    const added = names.filter((name) => !baseSet.has(name));
    const removed = baseNames.filter((name) => !branchSet.has(name));

    for (const name of added) {
      const prefix = parsed.get(name);
      if (prefix && prefix.kind === "legacy") {
        failures.push(
          `${name} is new on this branch but named under the retired NNN_ scheme. ` +
            `Deployed databases track migrations by full filename, and a counter two ` +
            `branches can both read is how prefixes collided six times. ${HOW_TO_NAME}`,
        );
      }
    }

    for (const name of removed) {
      failures.push(
        `${name} exists on ${baseRef} (at ${base.slice(0, 12)}) but not on this branch. A migration is never renamed ` +
          "or renumbered: schema_migrations keys on the filename, so the new name would " +
          "be applied again on every database that already recorded the old one. " +
          "Restore the file; ship a change as a new timestamp-prefixed migration.",
      );
    }

    notes.push(
      `compared against ${baseRef} at ${base.slice(0, 12)}: ${added.length} migration(s) added on this branch` +
        (removed.length ? `, ${removed.length} missing from it` : "") +
        ".",
    );
  }
}

// ---------------------------------------------------------------------------

for (const note of notes) console.log(`note: ${note}`);

if (failures.length) {
  console.error("\nMigration prefix check failed:\n");
  for (const failure of failures) console.error(`  ${failure}`);
  console.error('\nSee database/CLAUDE.md, "Creating a New Migration".');
  process.exit(1);
}

console.log(`Migration prefix check: OK (${names.length} migrations)`);
