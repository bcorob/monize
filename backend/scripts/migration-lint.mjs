#!/usr/bin/env node
/**
 * Migration idempotency lint: a CI gate on `database/migrations/*.sql`.
 *
 * Migrations run unconditionally at startup and are tracked by filename in
 * `schema_migrations`. When a migration body half-applies (a crash between the
 * DDL and the tracker INSERT, a rewritten file on a dev DB, a restore from a
 * snapshot taken mid-deploy), the next boot re-runs the whole body. If any
 * statement in it is not re-runnable the backend crash-loops on
 * "trigger already exists" / "column already exists" and someone has to
 * hand-mark the migration applied -- exactly what happened with `056` in the
 * PR #192 thread (mny-import plan, task B1).
 *
 * So every statement must be a no-op against an up-to-date database. This
 * script encodes that rule: it flags DDL that lacks an `IF [NOT] EXISTS`
 * clause, a preceding `DROP ... IF EXISTS` of the same object, or an enclosing
 * conditional `DO` block.
 *
 * Usage:
 *   node scripts/migration-lint.mjs            # lint every migration (CI gate)
 *   node scripts/migration-lint.mjs --dir DIR  # lint another directory
 *
 * Escape hatch, for the rare statement that is provably re-runnable in a way
 * the rules cannot see -- the reason is mandatory:
 *   -- migration-lint-disable-next-line insert-without-on-conflict: reason
 *
 * See docs/database-migrations.md and docs/future-plans/mny-import.md (B1).
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const defaultDir = join(here, "..", "..", "database", "migrations");

const DISABLE_PRAGMA = "migration-lint-disable-next-line";

// ---------------------------------------------------------------------------
// Lexing: comment stripping and statement splitting
// ---------------------------------------------------------------------------

/**
 * Blank out `--` and block comments while preserving every byte offset (comment
 * characters become spaces, newlines survive), so reported line numbers still
 * point at the original file. Quote and dollar-quote state is tracked because
 * `--` inside a string literal or a plpgsql body is not a comment.
 */
export function stripComments(sql) {
  const out = Array.from(sql);
  let i = 0;
  const blank = (from, to) => {
    for (let k = from; k < to; k++) if (out[k] !== "\n") out[k] = " ";
  };
  while (i < sql.length) {
    const two = sql.slice(i, i + 2);
    if (two === "--") {
      const end = sql.indexOf("\n", i);
      const stop = end === -1 ? sql.length : end;
      blank(i, stop);
      i = stop;
      continue;
    }
    if (two === "/*") {
      const end = sql.indexOf("*/", i + 2);
      const stop = end === -1 ? sql.length : end + 2;
      blank(i, stop);
      i = stop;
      continue;
    }
    if (sql[i] === "'") {
      i = skipSingleQuoted(sql, i);
      continue;
    }
    const tag = dollarTagAt(sql, i);
    if (tag) {
      const end = sql.indexOf(tag, i + tag.length);
      i = end === -1 ? sql.length : end + tag.length;
      continue;
    }
    i++;
  }
  return out.join("");
}

/** Index just past the closing quote of the single-quoted literal at `i`. */
function skipSingleQuoted(sql, i) {
  let k = i + 1;
  while (k < sql.length) {
    if (sql[k] === "'") {
      if (sql[k + 1] === "'") {
        k += 2;
        continue;
      }
      return k + 1;
    }
    k++;
  }
  return sql.length;
}

/** The dollar-quote tag starting at `i` (`$$`, `$body$`), or null. */
function dollarTagAt(sql, i) {
  if (sql[i] !== "$") return null;
  const match = /^\$[A-Za-z_][A-Za-z0-9_]*\$|^\$\$/.exec(sql.slice(i));
  return match ? match[0] : null;
}

/**
 * Split `sql` (already comment-stripped) into statements, flattened: a
 * dollar-quoted body (a `DO` block, a function body) yields both the outer
 * statement and the statements inside it, the latter carrying `blockText` so
 * rules can tell they sit in a conditional block.
 *
 * Each entry is `{ text, start, blockText }` with `start` a byte offset into
 * `sql`, which `lineOf` turns into a line number.
 */
export function splitStatements(sql, offset = 0, blockText = null) {
  const statements = [];
  let start = 0;
  let i = 0;
  // `start` points at the first non-whitespace character so reported line
  // numbers name the statement's own line, not the newline that ended the
  // previous one.
  const push = (from, to) => {
    const raw = sql.slice(from, to);
    if (!raw.trim()) return;
    const lead = /^\s*/.exec(raw)[0].length;
    statements.push({
      text: raw.slice(lead),
      start: offset + from + lead,
      blockText,
    });
  };
  while (i < sql.length) {
    if (sql[i] === "'") {
      i = skipSingleQuoted(sql, i);
      continue;
    }
    const tag = dollarTagAt(sql, i);
    if (tag) {
      const bodyStart = i + tag.length;
      const end = sql.indexOf(tag, bodyStart);
      const bodyEnd = end === -1 ? sql.length : end;
      const bodyOffset = offset + bodyStart;
      const body = sql.slice(bodyStart, bodyEnd);
      i = end === -1 ? sql.length : end + tag.length;
      const outerEnd = sql.indexOf(";", i);
      const stop = outerEnd === -1 ? sql.length : outerEnd;
      // The wrapper (`DO $$ ... $$`, `CREATE FUNCTION ... $$ ... $$`) is one
      // statement and the body's statements are separate ones. Blank the body
      // out of the wrapper's text -- otherwise every statement inside a
      // conditional block would also be judged as unguarded wrapper text.
      const outerRaw =
        sql.slice(start, bodyStart) +
        " ".repeat(bodyEnd - bodyStart) +
        sql.slice(bodyEnd, stop);
      const outerLead = /^\s*/.exec(outerRaw)[0].length;
      const outerText = outerRaw.slice(outerLead);
      if (outerText.trim()) {
        statements.push({
          text: outerText,
          start: offset + start + outerLead,
          blockText,
        });
      }
      statements.push(...splitStatements(body, bodyOffset, outerText + body));
      i = stop + 1;
      start = i;
      continue;
    }
    if (sql[i] === ";") {
      push(start, i);
      i++;
      start = i;
      continue;
    }
    i++;
  }
  push(start, sql.length);
  return statements;
}

/** 1-based line number of byte `offset` in `sql`. */
export function lineOf(sql, offset) {
  let line = 1;
  for (let i = 0; i < offset && i < sql.length; i++) {
    if (sql[i] === "\n") line++;
  }
  return line;
}

// ---------------------------------------------------------------------------
// Guard detection
// ---------------------------------------------------------------------------

/**
 * True when the statement sits inside a `DO` block (or function body) that
 * tests for the object's existence first -- the `056` pg_trigger pattern. The
 * test is deliberately coarse: any catalog probe or `IF [NOT] EXISTS (` in the
 * enclosing block counts, because a block that bothers to probe the catalog is
 * a block whose author was thinking about re-runs.
 */
export function isBlockGuarded(blockText) {
  if (!blockText) return false;
  return (
    /\bIF\s+(NOT\s+)?EXISTS\s*\(/i.test(blockText) ||
    /\bpg_(trigger|policies|policy|constraint|type|class|indexes|matviews|proc|attribute)\b/i.test(
      blockText,
    ) ||
    /\binformation_schema\./i.test(blockText)
  );
}

/** Strip quotes and schema qualification from an identifier for comparison. */
export function normalizeIdentifier(raw) {
  if (!raw) return "";
  const bare = raw.trim().replace(/"/g, "");
  const parts = bare.split(".");
  return parts[parts.length - 1].toLowerCase();
}

/**
 * Names dropped with `DROP <kind> IF EXISTS` earlier in the file, keyed
 * `kind:name`. `%I` is recorded verbatim so a `format()`-driven
 * drop-then-create loop (the RLS policy migrations) resolves as guarded.
 */
export function collectDrops(statements, upToIndex) {
  const drops = new Set();
  const patterns = [
    {
      kind: "trigger",
      regex: /\bDROP\s+TRIGGER\s+IF\s+EXISTS\s+(%I|[A-Za-z0-9_"]+)/gi,
    },
    {
      kind: "policy",
      regex: /\bDROP\s+POLICY\s+IF\s+EXISTS\s+(%I|[A-Za-z0-9_"]+)/gi,
    },
    {
      kind: "constraint",
      regex: /\bDROP\s+CONSTRAINT\s+IF\s+EXISTS\s+(%I|[A-Za-z0-9_"]+)/gi,
    },
  ];
  for (let i = 0; i < upToIndex; i++) {
    const { text } = statements[i];
    for (const { kind, regex } of patterns) {
      for (const match of text.matchAll(regex)) {
        drops.add(`${kind}:${normalizeIdentifier(match[1])}`);
      }
    }
  }
  return drops;
}

// ---------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------

/**
 * Each rule inspects one statement and returns an array of messages (empty when
 * satisfied). `ctx` carries `{ blockGuarded, drops }`.
 *
 * Statements that are inherently re-runnable are simply not covered by a rule:
 * `CREATE OR REPLACE`, `ALTER COLUMN ... TYPE/SET/DROP`, `COMMENT ON`, `GRANT`,
 * `ENABLE ROW LEVEL SECURITY`, and data `UPDATE`/`DELETE` (their WHERE clauses
 * normally select the pre-migration state and match nothing on a second pass).
 *
 * `NON_RERUNNABLE_DATA_MIGRATIONS` names the exceptions to that last clause --
 * data repairs whose WHERE cannot exclude their own result -- so the summary
 * line stops claiming a property one file does not have.
 */
/**
 * Normalized role names out of a `TO`/`FROM` grantee list ("PUBLIC,
 * monize_app WITH GRANT OPTION" -> ["public", "monize_app"]). Tail options are
 * cut first so `WITH GRANT OPTION` / `GRANTED BY` / `CASCADE` are not mistaken
 * for grantees. An entry the grammar cannot read comes back as "" -- not
 * provably PUBLIC, so the caller flags it rather than passing it.
 */
function granteesOf(listText) {
  return listText
    .replace(/\b(?:WITH|GRANTED\s+BY|CASCADE|RESTRICT)\b[\s\S]*$/i, "")
    .split(",")
    .map((entry) => {
      const token = /^(?:GROUP\s+)?([A-Za-z_"][\w"$]*)/i.exec(entry.trim());
      return token ? normalizeIdentifier(token[1]) : "";
    });
}

/** True when a grantee list is anything other than exactly PUBLIC entries. */
function namesARole(grantees) {
  return grantees.length === 0 || grantees.some((name) => name !== "public");
}

export const RULES = [
  {
    id: "create-table-without-if-not-exists",
    check(text, ctx) {
      const regex =
        /\bCREATE\s+(?:UNLOGGED\s+)?TABLE\s+(?!IF\s+NOT\s+EXISTS)(?!TEMP|TEMPORARY)/gi;
      if (!regex.test(text) || ctx.blockGuarded) return [];
      return ["CREATE TABLE without IF NOT EXISTS"];
    },
  },
  {
    id: "create-index-without-if-not-exists",
    check(text, ctx) {
      const regex =
        /\bCREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:CONCURRENTLY\s+)?(?!IF\s+NOT\s+EXISTS)(?!CONCURRENTLY)/gi;
      if (!regex.test(text) || ctx.blockGuarded) return [];
      return ["CREATE INDEX without IF NOT EXISTS"];
    },
  },
  {
    id: "add-column-without-if-not-exists",
    check(text, ctx) {
      if (ctx.blockGuarded) return [];
      const messages = [];
      for (const match of text.matchAll(
        /\bADD\s+COLUMN\s+(?!IF\s+NOT\s+EXISTS)([A-Za-z0-9_"]+)/gi,
      )) {
        messages.push(`ADD COLUMN ${match[1]} without IF NOT EXISTS`);
      }
      // `ALTER TABLE t ADD col type` (the COLUMN keyword is optional in
      // Postgres) can never carry the guard, so it is banned outright.
      for (const match of text.matchAll(
        /\bADD\s+(?!COLUMN\b|CONSTRAINT\b|PRIMARY\b|FOREIGN\b|UNIQUE\b|CHECK\b|EXCLUDE\b|VALUE\b|GENERATED\b|IF\b)([A-Za-z0-9_"]+)\s+[A-Za-z]/gi,
      )) {
        messages.push(
          `ADD ${match[1]} without the COLUMN keyword -- write ADD COLUMN IF NOT EXISTS ${match[1]}`,
        );
      }
      return messages;
    },
  },
  {
    id: "drop-without-if-exists",
    check(text, ctx) {
      if (ctx.blockGuarded) return [];
      const kinds =
        "TABLE|INDEX|TRIGGER|POLICY|VIEW|TYPE|SEQUENCE|CONSTRAINT|COLUMN|FUNCTION|EXTENSION|SCHEMA|MATERIALIZED\\s+VIEW";
      const regex = new RegExp(
        `\\bDROP\\s+(${kinds})\\s+(?!IF\\s+EXISTS)`,
        "gi",
      );
      const messages = [];
      for (const match of text.matchAll(regex)) {
        messages.push(`DROP ${match[1].toUpperCase()} without IF EXISTS`);
      }
      return messages;
    },
  },
  {
    id: "add-constraint-without-drop",
    check(text, ctx) {
      if (ctx.blockGuarded) return [];
      const messages = [];
      for (const match of text.matchAll(
        /\bADD\s+CONSTRAINT\s+([A-Za-z0-9_"]+)/gi,
      )) {
        const name = normalizeIdentifier(match[1]);
        if (
          ctx.drops.has(`constraint:${name}`) ||
          ctx.drops.has("constraint:%i")
        )
          continue;
        messages.push(
          `ADD CONSTRAINT ${match[1]} is not preceded by DROP CONSTRAINT IF EXISTS ${match[1]}`,
        );
      }
      return messages;
    },
  },
  {
    id: "create-trigger-without-drop",
    check(text, ctx) {
      if (ctx.blockGuarded) return [];
      const messages = [];
      for (const match of text.matchAll(
        /\bCREATE\s+(?:OR\s+REPLACE\s+)?(?:CONSTRAINT\s+)?TRIGGER\s+([A-Za-z0-9_"]+)/gi,
      )) {
        if (/\bCREATE\s+OR\s+REPLACE\s+TRIGGER\b/i.test(text)) continue;
        const name = normalizeIdentifier(match[1]);
        if (ctx.drops.has(`trigger:${name}`) || ctx.drops.has("trigger:%i"))
          continue;
        messages.push(
          `CREATE TRIGGER ${match[1]} is neither preceded by DROP TRIGGER IF EXISTS ${match[1]} nor inside a pg_trigger existence check`,
        );
      }
      return messages;
    },
  },
  {
    id: "create-policy-without-drop",
    check(text, ctx) {
      if (ctx.blockGuarded) return [];
      const messages = [];
      for (const match of text.matchAll(
        /\bCREATE\s+POLICY\s+(%I|[A-Za-z0-9_"]+)/gi,
      )) {
        const name = normalizeIdentifier(match[1]);
        if (ctx.drops.has(`policy:${name}`) || ctx.drops.has("policy:%i"))
          continue;
        messages.push(
          `CREATE POLICY ${match[1]} is not preceded by DROP POLICY IF EXISTS ${match[1]}`,
        );
      }
      return messages;
    },
  },
  {
    id: "enum-add-value-without-if-not-exists",
    check(text, ctx) {
      if (ctx.blockGuarded) return [];
      if (!/\bALTER\s+TYPE\s+[^;]*\bADD\s+VALUE\b/i.test(text)) return [];
      if (/\bADD\s+VALUE\s+IF\s+NOT\s+EXISTS\b/i.test(text)) return [];
      return ["ALTER TYPE ... ADD VALUE without IF NOT EXISTS"];
    },
  },
  {
    id: "create-type-without-guard",
    check(text, ctx) {
      if (ctx.blockGuarded) return [];
      if (!/\bCREATE\s+TYPE\s+/i.test(text)) return [];
      return [
        "CREATE TYPE has no IF NOT EXISTS clause -- wrap it in a DO block that checks pg_type",
      ];
    },
  },
  {
    id: "create-function-without-or-replace",
    check(text, ctx) {
      if (ctx.blockGuarded) return [];
      if (!/\bCREATE\s+FUNCTION\s+/i.test(text)) return [];
      return ["CREATE FUNCTION without OR REPLACE"];
    },
  },
  {
    id: "create-view-without-or-replace",
    check(text, ctx) {
      if (ctx.blockGuarded) return [];
      const messages = [];
      if (/\bCREATE\s+VIEW\s+/i.test(text)) {
        messages.push("CREATE VIEW without OR REPLACE");
      }
      if (
        /\bCREATE\s+MATERIALIZED\s+VIEW\s+/i.test(text) &&
        !/\bCREATE\s+MATERIALIZED\s+VIEW\s+IF\s+NOT\s+EXISTS\b/i.test(text)
      ) {
        messages.push("CREATE MATERIALIZED VIEW without IF NOT EXISTS");
      }
      return messages;
    },
  },
  {
    id: "create-object-without-if-not-exists",
    check(text, ctx) {
      if (ctx.blockGuarded) return [];
      const messages = [];
      for (const kind of ["SEQUENCE", "EXTENSION", "SCHEMA"]) {
        const regex = new RegExp(
          `\\bCREATE\\s+${kind}\\s+(?!IF\\s+NOT\\s+EXISTS)`,
          "i",
        );
        if (regex.test(text))
          messages.push(`CREATE ${kind} without IF NOT EXISTS`);
      }
      return messages;
    },
  },
  {
    id: "insert-without-on-conflict",
    check(text, ctx) {
      if (ctx.blockGuarded) return [];
      if (!/\bINSERT\s+INTO\b/i.test(text)) return [];
      if (/\bON\s+CONFLICT\b/i.test(text)) return [];
      if (/\bWHERE\s+NOT\s+EXISTS\b/i.test(text)) return [];
      return [
        "INSERT INTO without ON CONFLICT (or a WHERE NOT EXISTS guard) duplicates rows on a re-run",
      ];
    },
  },
  /**
   * Not idempotency -- deployability. A migration runs unconditionally at
   * startup on every installation, including ones where the runtime role does
   * not exist (it is provisioned by db-init, or by the CNPG Cluster manifest, or
   * not at all at RLS_MODE=off). A statement naming that role fails, the
   * migration aborts, and the backend crash-loops before it serves a request.
   * Roles and their grants therefore live in `backend/src/common/db/app-role.ts`,
   * and no shipped migration contains any of these statements today -- the test
   * suite pins that over the real directory.
   *
   * `PUBLIC` is the one exception, and it is not an exception to the reason:
   * PUBLIC is a keyword that always resolves, so `REVOKE ... FROM PUBLIC` cannot
   * fail for a missing role. It stays allowed because `CREATE FUNCTION` grants
   * EXECUTE to PUBLIC implicitly, and revoking that anywhere but in the same
   * transaction as the CREATE leaves a window in which any role can execute a
   * fresh SECURITY DEFINER function. Nothing in the tree needs it yet; the
   * allowance exists so the first migration that ships such a function can close
   * that window in place instead of fighting this rule.
   *
   * Every grantee is checked, not just the first: `REVOKE ... FROM PUBLIC,
   * monize_app` names a role exactly as much as `FROM monize_app` does. The
   * other statements that bind a specific role -- `OWNER TO`, `REASSIGN OWNED
   * BY`, `SET ROLE` / `SET SESSION AUTHORIZATION`, and a policy's `TO` clause
   * -- fail the same way a GRANT does, so they are covered by the same rule.
   */
  {
    id: "role-or-grant-statement",
    check(text) {
      const messages = [];
      if (/\b(?:CREATE|ALTER|DROP)\s+(?:ROLE|USER|GROUP)\b/i.test(text)) {
        messages.push(
          "CREATE/ALTER/DROP ROLE in a migration crash-loops startup where the role differs; roles live in db-init (common/db/app-role.ts)",
        );
      }
      if (/\bOWNER\s+TO\b/i.test(text)) {
        messages.push(
          "ALTER ... OWNER TO names a role, and crash-loops startup where that role does not exist; ownership stays with the migration-running role",
        );
      }
      if (/\bREASSIGN\s+OWNED\s+BY\b/i.test(text)) {
        messages.push(
          "REASSIGN OWNED BY names roles, and crash-loops startup where they do not exist",
        );
      }
      // Anchored to the statement start: SET ROLE is a statement of its own,
      // and the anchor keeps the words appearing inside a string literal (an
      // INSERTed comment, say) from tripping the rule.
      if (
        /^\s*SET\s+(?:LOCAL\s+|SESSION\s+)?ROLE\b/i.test(text) ||
        /^\s*SET\s+(?:LOCAL\s+)?SESSION\s+AUTHORIZATION\b/i.test(text)
      ) {
        messages.push(
          "SET ROLE / SET SESSION AUTHORIZATION switches to a named role, and crash-loops startup where that role does not exist",
        );
      }
      // A policy's TO clause binds it to roles at CREATE/ALTER time and fails
      // for a missing role exactly like a GRANT. The clause sits before
      // USING / WITH CHECK, so only that head is searched -- a column named
      // granted_to inside the predicate is not a TO clause -- and RENAME TO
      // renames the policy, not a role.
      if (/\b(?:CREATE|ALTER)\s+POLICY\b/i.test(text)) {
        const head = text
          .split(/\bUSING\b|\bWITH\s+CHECK\b/i)[0]
          .replace(/\bRENAME\s+TO\s+[A-Za-z_"][\w"$]*/i, " ");
        const toClause = /\bTO\s+([\s\S]+)$/i.exec(head);
        if (toClause && namesARole(granteesOf(toClause[1]))) {
          messages.push(
            "CREATE/ALTER POLICY ... TO names a role, and crash-loops startup where that role does not exist; leave the policy on its default (PUBLIC)",
          );
        }
      }
      const grant = /\b(GRANT|REVOKE)\b([\s\S]*)$/i.exec(text);
      if (grant) {
        // The grantee list follows TO (GRANT) or FROM (REVOKE); every
        // comma-separated entry is checked -- `FROM PUBLIC, monize_app` names
        // a role exactly as much as `FROM monize_app` does.
        const list = /\b(?:TO|FROM)\s+([\s\S]+)$/i.exec(grant[2]);
        if (!list || namesARole(granteesOf(list[1]))) {
          messages.push(
            `${grant[1].toUpperCase()} to a named role in a migration crash-loops startup where the role does not exist; only PUBLIC is safe (it always resolves)`,
          );
        }
      }
      return messages;
    },
  },
];

// ---------------------------------------------------------------------------
// Linting
// ---------------------------------------------------------------------------

/**
 * Rule ids suppressed for the line that follows a
 * `-- migration-lint-disable-next-line <rule>: <reason>` comment. Returns a map
 * of line number -> Set of rule ids. A pragma without a reason is itself a
 * finding, reported by `lintSql`.
 */
export function collectPragmas(sql) {
  const suppressed = new Map();
  const problems = [];
  const lines = sql.split("\n");
  lines.forEach((line, index) => {
    const match = new RegExp(
      `--\\s*${DISABLE_PRAGMA}\\s+([a-z0-9-]+)\\s*(:\\s*(.*))?$`,
      "i",
    ).exec(line);
    if (!match) return;
    const ruleId = match[1];
    const reason = (match[3] || "").trim();
    if (!RULES.some((r) => r.id === ruleId)) {
      problems.push({
        line: index + 1,
        message: `unknown lint rule "${ruleId}" in disable pragma`,
      });
      return;
    }
    if (!reason) {
      problems.push({
        line: index + 1,
        message: `disable pragma for "${ruleId}" needs a reason after the colon`,
      });
      return;
    }
    // The pragma applies to the next non-blank line onwards; a statement may
    // start there and continue, so suppress by the statement's first line.
    let target = index + 2;
    while (target <= lines.length && !lines[target - 1].trim()) target++;
    const existing = suppressed.get(target) ?? new Set();
    existing.add(ruleId);
    suppressed.set(target, existing);
  });
  return { suppressed, problems };
}

/** Lint one migration's SQL. Returns `{ findings }`, each with line + rule. */
export function lintSql(sql, filename = "<sql>") {
  const { suppressed, problems } = collectPragmas(sql);
  const findings = problems.map((p) => ({
    file: filename,
    line: p.line,
    rule: "pragma",
    message: p.message,
  }));

  const stripped = stripComments(sql);
  const statements = splitStatements(stripped);

  statements.forEach((statement, index) => {
    const ctx = {
      blockGuarded: isBlockGuarded(statement.blockText),
      drops: collectDrops(statements, index),
    };
    const line = lineOf(stripped, statement.start);
    for (const rule of RULES) {
      const suppressions = suppressed.get(line);
      if (suppressions?.has(rule.id)) continue;
      for (const message of rule.check(statement.text, ctx)) {
        findings.push({ file: filename, line, rule: rule.id, message });
      }
    }
  });

  return { findings };
}

/**
 * Data repairs that are correct exactly once, with the reason their `WHERE`
 * cannot select only the pre-migration state.
 *
 * The single-run mechanism is `schema_migrations`: `db-migrate` reads the
 * applied filenames before each pass and executes only the ones missing, so a
 * body listed here runs once per database. That is a real mechanism and it is
 * named here rather than assumed -- what it does NOT survive is somebody
 * replaying a file by hand against a populated database, which is why the entry
 * says what a second pass would do.
 *
 * An entry is a claim about a file, so the lint fails when the file is gone.
 */
export const NON_RERUNNABLE_DATA_MIGRATIONS = new Map([
  [
    "166_heal_loan_schedule_end_dates.sql",
    "Steps a loan/mortgage schedule's end_date back one interval. The healed " +
      "value is still a whole number of intervals from start_date, which is " +
      "the only signature a machine-written bound has, so a second pass would " +
      "step it back again and retire the schedule one payment early.",
  ],
]);

/**
 * Registered one-shot migrations that are no longer on disk.
 *
 * An entry in the register is a claim about a file: once the file is renamed or
 * deleted the entry is a note about nothing, and the summary line goes on
 * excusing a body that is not there. Named and exported so the self-test can
 * exercise the failure without running `main`.
 */
export function missingOneShotMigrations(files) {
  return [...NON_RERUNNABLE_DATA_MIGRATIONS.keys()].filter(
    (name) => !files.includes(name),
  );
}

/** Lint every `.sql` file in `dir`, sorted by filename. */
export function lintDirectory(dir) {
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  const findings = [];
  for (const file of files) {
    const sql = readFileSync(join(dir, file), "utf8");
    findings.push(...lintSql(sql, basename(file)).findings);
  }
  return { files, findings };
}

function main() {
  const dirFlag = process.argv.indexOf("--dir");
  const dir = dirFlag === -1 ? defaultDir : process.argv[dirFlag + 1];

  if (!statSync(dir, { throwIfNoEntry: false })?.isDirectory()) {
    console.error(`Migration lint: no such directory: ${dir}`);
    process.exit(1);
  }

  const { files, findings } = lintDirectory(dir);
  console.log(`Migration idempotency lint: ${files.length} file(s) in ${dir}`);

  const missing = missingOneShotMigrations(files);
  if (missing.length > 0) {
    console.error("");
    for (const name of missing) {
      console.error(
        `FAIL: ${name} is registered as a one-shot data migration but no longer exists -- ` +
          "remove its entry from NON_RERUNNABLE_DATA_MIGRATIONS.",
      );
    }
    process.exit(1);
  }

  if (findings.length === 0) {
    if (NON_RERUNNABLE_DATA_MIGRATIONS.size === 0) {
      console.log(
        "OK -- every migration body is re-runnable against an up-to-date database.",
      );
      return;
    }
    console.log(
      `OK -- every migration body is re-runnable against an up-to-date database, except ${NON_RERUNNABLE_DATA_MIGRATIONS.size} ` +
        "registered one-shot data repair(s), run once each by schema_migrations:",
    );
    for (const [name, reason] of NON_RERUNNABLE_DATA_MIGRATIONS) {
      console.log(`  ${name}: ${reason}`);
    }
    return;
  }

  console.error("");
  for (const finding of findings) {
    console.error(
      `FAIL: ${finding.file}:${finding.line} [${finding.rule}] ${finding.message}`,
    );
  }
  // Two failure families, two remedies. Naming only the idempotency one sent a
  // reader of a role/grant finding looking for an IF NOT EXISTS clause to add.
  const hasRoleFinding = findings.some(
    (f) => f.rule === "role-or-grant-statement",
  );
  const hasIdempotencyFinding = findings.some(
    (f) => f.rule !== "role-or-grant-statement",
  );
  const remedies = [];
  if (hasIdempotencyFinding) {
    remedies.push(
      "Migrations must be no-ops when re-run: a half-applied migration otherwise\n" +
        "crash-loops the backend at startup. Add the IF [NOT] EXISTS clause, a preceding\n" +
        "DROP ... IF EXISTS, or wrap the statement in a catalog-checking DO block.",
    );
  }
  if (hasRoleFinding) {
    remedies.push(
      "Migrations must not name a role: they run unconditionally at startup, including\n" +
        "where that role does not exist. Move it to backend/src/common/db/app-role.ts,\n" +
        "which db-init applies idempotently. Only PUBLIC is safe in a migration.",
    );
  }
  console.error(
    `\n${findings.length} finding(s).\n\n` +
      remedies.join("\n\n") +
      "\n\nSee docs/database-migrations.md.",
  );
  process.exit(1);
}

if (
  process.argv[1] &&
  statSync(process.argv[1], { throwIfNoEntry: false })?.isFile()
) {
  const invoked = fileURLToPath(import.meta.url);
  if (process.argv[1] === invoked) main();
}
