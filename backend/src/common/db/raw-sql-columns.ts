/**
 * The grammar that decides whether a column name written in raw SQL inside
 * `src/` is a real column of the table the statement targets.
 *
 * A mocked `manager.query` cannot demonstrate a property of the schema: it
 * records the string and resolves. So `RETURNING id` against
 * `auto_backup_settings` -- whose primary key is `user_id`, and which has no
 * `id` at all -- passed its unit tests, shipped, and took every automatic
 * backup down for every user with `column "id" does not exist` (42703). The
 * claim runs before the per-user `try`, so the first failure aborted the whole
 * sweep.
 *
 * Extracted from the spec so the grammar itself is unit-tested rather than only
 * exercised over whatever the tree happens to contain today -- the same reason
 * `repo-paths.util.ts` sits beside `doc-paths.spec.ts`.
 *
 * What is checked, per raw DML statement, against `database/schema.sql`:
 *
 *  - the `RETURNING` list,
 *  - an `INSERT`'s parenthesised column list,
 *  - an `UPDATE`'s `SET` assignment targets.
 *
 * What is deliberately *not* checked: anything the scanner cannot resolve
 * unambiguously -- an expression, a `*`, a name qualified by something other
 * than the target table or its alias (a CTE or a joined relation), or an item
 * carrying a `${...}` interpolation. Those yield no claim rather than a guess,
 * because a guard that reports false positives gets disabled and then reports
 * nothing at all. `WHERE` clauses are out of scope for the same reason: they
 * reference joined and correlated relations freely.
 */

/** A column reference a statement makes, with enough context to explain it. */
export interface ColumnClaim {
  table: string;
  column: string;
  /** Which clause it came from, for the failure message. */
  clause: "RETURNING" | "INSERT" | "SET";
}

/** A DML statement found in a SQL string, reduced to the claims it makes. */
export interface StatementClaims {
  table: string;
  claims: ColumnClaim[];
}

const IDENT = "[A-Za-z_][A-Za-z0-9_$]*";

/**
 * Words that may follow a table name in DML and are therefore never an alias.
 * `SET` is the one that matters -- `UPDATE auto_backup_settings SET ...` would
 * otherwise be read as table `auto_backup_settings` aliased `SET`, and every
 * unqualified column would still resolve, but a `SET`-qualified one would be
 * skipped as "some other relation": the guard passing by not looking.
 */
const NOT_AN_ALIAS = new Set([
  "set",
  "where",
  "values",
  "returning",
  "using",
  "from",
  "select",
  "on",
  "default",
  "overriding",
]);

/** A `${...}` interpolation, replaced by a marker the scanner can recognise. */
export const INTERPOLATION = " interp ";

// ---------------------------------------------------------------------------
// database/schema.sql -> table -> columns
// ---------------------------------------------------------------------------

/**
 * Entries in a `CREATE TABLE` body that declare a constraint rather than a
 * column. `PRIMARY`, `UNIQUE` and `FOREIGN` also begin *column* modifiers, but
 * only ever after the column name, so matching them as the entry's first word
 * is exact.
 */
const CONSTRAINT_KEYWORDS = new Set([
  "constraint",
  "primary",
  "foreign",
  "unique",
  "check",
  "exclude",
  "like",
]);

/** Split on commas that are not inside parentheses. */
export function splitTopLevel(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = "";
  for (const ch of text) {
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
    if (ch === "," && depth === 0) {
      parts.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  parts.push(current);
  return parts.map((part) => part.trim()).filter(Boolean);
}

/** From the index of an opening `(`, the index of its matching `)`, or -1. */
function matchParen(text: string, open: number): number {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === "(") depth++;
    else if (text[i] === ")" && --depth === 0) return i;
  }
  return -1;
}

/**
 * Table name -> its column names, from `database/schema.sql`.
 *
 * Comments are stripped first so a commented-out column is not read as one.
 * Both `CREATE TABLE x` and `CREATE TABLE IF NOT EXISTS x` are matched, because
 * migrations replay onto the schema and use the guarded form.
 */
export function parseSchemaColumns(
  schemaSql: string,
): Map<string, Set<string>> {
  const sql = schemaSql.replace(/--[^\n]*/g, "");
  const tables = new Map<string, Set<string>>();
  const create = new RegExp(
    `CREATE\\s+TABLE\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?"?(${IDENT})"?\\s*\\(`,
    "gi",
  );
  for (const match of sql.matchAll(create)) {
    const open = match.index + match[0].length - 1;
    const close = matchParen(sql, open);
    if (close < 0) continue;
    const columns = new Set<string>();
    for (const entry of splitTopLevel(sql.slice(open + 1, close))) {
      const first = new RegExp(`^"?(${IDENT})"?`).exec(entry);
      if (!first) continue;
      if (CONSTRAINT_KEYWORDS.has(first[1].toLowerCase())) continue;
      columns.add(first[1].toLowerCase());
    }
    tables.set(match[1].toLowerCase(), columns);
  }
  return tables;
}

// ---------------------------------------------------------------------------
// TypeScript source -> the SQL strings in it
// ---------------------------------------------------------------------------

/**
 * Every string and template literal in a TypeScript source, with `${...}`
 * interpolations replaced by a marker.
 *
 * Written as a character scanner rather than a regex because a SQL statement in
 * this codebase is a multi-line template literal, frequently with an
 * interpolated fragment in its `WHERE`. Comments are skipped so the SQL quoted
 * *inside* a doc comment -- and this file is full of it -- is never scanned as
 * code.
 */
export function extractStringLiterals(source: string): string[] {
  const literals: string[] = [];
  const n = source.length;
  let i = 0;
  while (i < n) {
    const ch = source[i];
    const next = source[i + 1];
    if (ch === "/" && next === "/") {
      while (i < n && source[i] !== "\n") i++;
      continue;
    }
    if (ch === "/" && next === "*") {
      const end = source.indexOf("*/", i + 2);
      i = end < 0 ? n : end + 2;
      continue;
    }
    if (ch === "'" || ch === '"') {
      let j = i + 1;
      let text = "";
      while (j < n && source[j] !== ch && source[j] !== "\n") {
        if (source[j] === "\\") {
          j += 2;
          text += " ";
          continue;
        }
        text += source[j];
        j++;
      }
      literals.push(text);
      i = j + 1;
      continue;
    }
    if (ch === "`") {
      let j = i + 1;
      let text = "";
      while (j < n && source[j] !== "`") {
        if (source[j] === "\\") {
          j += 2;
          text += " ";
          continue;
        }
        if (source[j] === "$" && source[j + 1] === "{") {
          // Skip the interpolation body, tracking nesting so an object literal
          // or a nested template inside it does not end the scan early.
          let depth = 1;
          j += 2;
          while (j < n && depth > 0) {
            if (source[j] === "{") depth++;
            else if (source[j] === "}") depth--;
            else if (source[j] === "`") {
              j++;
              while (j < n && source[j] !== "`")
                j += source[j] === "\\" ? 2 : 1;
            }
            j++;
          }
          text += INTERPOLATION;
          continue;
        }
        text += source[j];
        j++;
      }
      literals.push(text);
      i = j + 1;
      continue;
    }
    i++;
  }
  return literals;
}

// ---------------------------------------------------------------------------
// SQL string -> the column claims it makes
// ---------------------------------------------------------------------------

/** The identifier a claim can be checked from, or null when it cannot be. */
function resolveColumn(
  item: string,
  table: string,
  alias: string | null,
): string | null {
  const text = item.trim();
  if (!text || text.includes(INTERPOLATION.trim())) return null;
  const qualified = new RegExp(`^(?:"?(${IDENT})"?\\.)?"?(${IDENT})"?$`).exec(
    text,
  );
  if (!qualified) return null; // an expression, a `*`, a literal, a cast
  const qualifier = qualified[1]?.toLowerCase();
  if (qualifier && qualifier !== table && qualifier !== alias) return null;
  return qualified[2].toLowerCase();
}

/**
 * Strip a `RETURNING expr AS name` / `expr name` output label, but only when
 * what remains is itself a (possibly qualified) identifier -- otherwise
 * `u.locked_until` would lose its qualifier to the "alias" branch and be
 * checked as a column named `u`.
 */
export function stripOutputLabel(item: string): string {
  const text = item.trim();
  const aliased = new RegExp(
    `^([\\s\\S]+?)\\s+(?:AS\\s+)?"?${IDENT}"?$`,
    "i",
  ).exec(text);
  const bare = new RegExp(`^(?:"?${IDENT}"?\\.)?"?${IDENT}"?$`);
  if (aliased && bare.test(aliased[1].trim())) return aliased[1].trim();
  return text;
}

/** Text of a clause: from `start` up to the first top-level stop word. */
function clauseText(sql: string, start: number, stops: RegExp): string {
  const rest = sql.slice(start);
  let depth = 0;
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === "(") depth++;
    else if (rest[i] === ")") depth--;
    else if (rest[i] === ";" && depth === 0) return rest.slice(0, i);
    if (depth !== 0) continue;
    stops.lastIndex = i;
    if (stops.test(rest)) return rest.slice(0, i);
  }
  return rest;
}

const DML = new RegExp(
  `\\b(UPDATE|INSERT\\s+INTO|DELETE\\s+FROM)\\s+(?:ONLY\\s+)?"?(${IDENT})"?` +
    `(?:\\s+(?:AS\\s+)?"?(${IDENT})"?)?`,
  "gi",
);

/** Sticky, so `clauseText` can ask "does a stop word start exactly here?". */
const SET_STOPS = /\b(?:FROM|WHERE|RETURNING)\b/giy;
const RETURNING_STOPS = /\bINTO\b/giy;

/**
 * The column claims every DML statement in one SQL string makes.
 *
 * A string with no DML verb yields nothing, so the scan is safe to run over
 * every literal in the tree rather than over a hand-maintained list of files.
 */
export function statementClaims(sql: string): StatementClaims[] {
  const statements: StatementClaims[] = [];
  const matches = [...sql.matchAll(DML)];
  for (const [index, match] of matches.entries()) {
    const verb = match[1].replace(/\s+/g, " ").toUpperCase();
    const table = match[2].toLowerCase();
    const aliasWord = match[3]?.toLowerCase() ?? null;
    const alias = aliasWord && !NOT_AN_ALIAS.has(aliasWord) ? aliasWord : null;
    const claims: ColumnClaim[] = [];
    // The statement ends where the next DML verb begins, so one string holding
    // two statements does not attribute the second's columns to the first.
    const nextMatch = matches[index + 1];
    const body = sql.slice(match.index, nextMatch?.index ?? sql.length);
    const afterTable = match[0].length;

    if (verb === "INSERT INTO") {
      const open = body.slice(afterTable).search(/\S/) + afterTable;
      if (body[open] === "(") {
        const close = matchParen(body, open);
        if (close > 0) {
          const columns = splitTopLevel(body.slice(open + 1, close)).map(
            (item) => resolveColumn(item, table, alias),
          );
          // All or nothing: `INSERT INTO t SELECT ...` and any list the scanner
          // cannot fully resolve must not contribute half a claim.
          if (
            columns.length > 0 &&
            columns.every((column) => column !== null)
          ) {
            for (const column of columns) {
              claims.push({
                table,
                column: column as string,
                clause: "INSERT",
              });
            }
          }
        }
      }
    }

    if (verb === "UPDATE") {
      const set = /\bSET\b/i.exec(body);
      if (set) {
        const text = clauseText(body, set.index + set[0].length, SET_STOPS);
        for (const assignment of splitTopLevel(text)) {
          if (assignment.startsWith("(")) continue; // SET (a, b) = (...)
          const column = resolveColumn(assignment.split("=")[0], table, alias);
          if (column) claims.push({ table, column, clause: "SET" });
        }
      }
    }

    const returning = /\bRETURNING\b/i.exec(body);
    if (returning) {
      const text = clauseText(
        body,
        returning.index + returning[0].length,
        RETURNING_STOPS,
      );
      for (const item of splitTopLevel(text)) {
        const column = resolveColumn(stripOutputLabel(item), table, alias);
        if (column) claims.push({ table, column, clause: "RETURNING" });
      }
    }

    if (claims.length > 0) statements.push({ table, claims });
  }
  return statements;
}

/**
 * A claim that names a column the schema does not have, described. `null` when
 * the claim holds, and when the table itself is unknown to `schema.sql` -- a
 * CTE, a temporary table or a `pg_catalog` relation is not a claim about the
 * application schema, and the table inventory is guarded elsewhere
 * (`rls-exempt-tables.spec.ts`, `restore-plan.spec.ts`).
 */
export function columnProblem(
  claim: ColumnClaim,
  schema: Map<string, Set<string>>,
): string | null {
  const columns = schema.get(claim.table);
  if (!columns) return null;
  if (columns.has(claim.column)) return null;
  return (
    `${claim.clause} ${claim.column} on ${claim.table}: no such column ` +
    `(database/schema.sql has ${[...columns].sort().join(", ")})`
  );
}
