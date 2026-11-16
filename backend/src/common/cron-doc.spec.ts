import { CronExpression } from "@nestjs/schedule";
import { readFileSync } from "fs";
import { basename, join } from "path";

import { findRepoRoot, gitListFiles, requireRepoRoot } from "./repo-tree.util";

/**
 * `docs/cron-jobs.md` is where `backend/CLAUDE.md` and `docs/backend/cron-and-background-work.md` send anyone asking what runs
 * on a schedule. It was missing six of them -- including `auto-backup.service`,
 * the subject of the very audit phase that led here -- and listed one
 * (`auth.service`) whose `@Cron` had moved to `token.service`.
 *
 * That is not a cosmetic gap. Every `@Cron` handler is an out-of-request entry
 * point that has to seed its own RLS context, every replica fires every cron, and
 * several of them send email or grant access. An operator reading the table would
 * not have learned that automatic backups, emergency-access escalation or the
 * matured-holdings rebuild happen at all.
 *
 * So the table is checked against the source, and not for membership only: each
 * row carries the handler's cron expression verbatim in the Cron column, and the
 * suite compares those expressions -- timezone included -- against the decorators.
 * Membership alone once let the table claim `accounts.service` ran at midnight
 * while the decorator said hourly; an expression the machine compares cannot
 * drift like prose can.
 *
 * The unit is the handler: one row per `@Cron`, so a service that quietly grows
 * a second schedule fails the suite. Handlers are keyed by file stem
 * (`auto-backup.service`), aggregated across files -- two files sharing a stem
 * both count, instead of the second silently overwriting the first -- and the
 * stem grammar does not require `.service`, so a handler that ever lands outside
 * a `*.service.ts` file can be documented rather than making the suite
 * unsatisfiable. A decorator the parser cannot read (a variable, a template
 * literal) is a loud failure listing the file, never a silently missing row.
 */

/** `expression` plus the timezone option, rendered the way the doc writes it. */
const renderSchedule = (expression: string, timeZone?: string): string =>
  timeZone ? `${expression} (${timeZone})` : expression;

const CRON_DECORATOR =
  /@Cron\(\s*(?:"([^"\n]+)"|'([^'\n]+)'|CronExpression\.([A-Za-z0-9_]+))\s*(?:,\s*\{([^}]*)\})?\s*\)/g;

export interface ParsedCrons {
  /** Rendered schedules, one per parsed decorator. */
  schedules: string[];
  /** Decorator lines the source declares, parseable or not. */
  anchors: number;
  /** Decorators the grammar could not resolve, with the reason. */
  problems: string[];
}

/**
 * Extract every `@Cron` decorator from one file's source. Pure, so the grammar
 * is unit-tested below. `anchors` counts decorator lines independently of the
 * parse; a caller failing on `anchors !== schedules.length` turns "the parser
 * missed one" into a red test naming the file instead of a missing row nobody
 * notices.
 */
export function parseCronDecorators(source: string): ParsedCrons {
  const schedules: string[] = [];
  const problems: string[] = [];
  for (const match of source.matchAll(CRON_DECORATOR)) {
    const [, doubleQuoted, singleQuoted, enumName, options] = match;
    let expression = doubleQuoted ?? singleQuoted;
    if (enumName !== undefined) {
      const resolved = (CronExpression as Record<string, string>)[enumName];
      if (!resolved) {
        problems.push(`CronExpression.${enumName} is not a known expression`);
        continue;
      }
      expression = resolved;
    }
    const timeZone = options
      ? /timeZone:\s*["']([^"']+)["']/.exec(options)?.[1]
      : undefined;
    schedules.push(renderSchedule(expression as string, timeZone));
  }
  const anchors = (source.match(/^\s*@Cron\(/gm) ?? []).length;
  return { schedules, anchors, problems };
}

export interface StemSchedules {
  files: string[];
  schedules: string[];
}

/**
 * Key parsed files by their stem (`auto-backup.service`), aggregating across
 * files: two files sharing a stem both contribute, instead of the second
 * silently overwriting the first.
 */
export function aggregateByStem(
  files: { path: string; schedules: string[] }[],
): Map<string, StemSchedules> {
  const byStem = new Map<string, StemSchedules>();
  for (const file of files) {
    if (file.schedules.length === 0) continue;
    const stem = basename(file.path).replace(/\.ts$/, "");
    const existing = byStem.get(stem) ?? { files: [], schedules: [] };
    byStem.set(stem, {
      files: [...existing.files, file.path],
      schedules: [...existing.schedules, ...file.schedules],
    });
  }
  return byStem;
}

export interface CronDocEntry {
  stem: string;
  schedule: string;
  /** The Purpose cell, trimmed; empty when the row has none. */
  purpose: string;
}

/**
 * Rows of the schedule table, every cell the suite reads: first column the
 * stem, second the expression, fourth the Purpose. Any stem, not just
 * `*.service`, so nothing representable in the source is unrepresentable in
 * the doc.
 *
 * One regex decides what a row is for both the schedule and the Purpose
 * checks, so a row cannot be counted by one and missed by the other. The
 * Purpose is everything after the Schedule cell up to the closing pipe; a row
 * that has no fourth cell yields an empty Purpose, which the vocabulary check
 * then fails by name rather than skipping.
 */
export function parseCronDocEntries(markdown: string): CronDocEntry[] {
  return [
    ...markdown.matchAll(
      /^\|\s*`([a-z0-9][a-z0-9.-]*)`\s*\|\s*`([^`\n]+)`(?:\s*\(([^)\n]+)\))?\s*\|([^\n]*)$/gm,
    ),
  ].map(([, stem, expression, timeZone, rest]) => {
    const afterSchedule = rest.indexOf("|");
    const purpose =
      afterSchedule === -1
        ? ""
        : rest
            .slice(afterSchedule + 1)
            .replace(/\|\s*$/, "")
            .trim();
    return { stem, schedule: renderSchedule(expression, timeZone), purpose };
  });
}

/** The stem and expression of each row, for the schedule comparison. */
export function parseCronDocRows(
  markdown: string,
): { stem: string; schedule: string }[] {
  return parseCronDocEntries(markdown).map(({ stem, schedule }) => ({
    stem,
    schedule,
  }));
}

/**
 * What a Purpose cell has to say: the mechanism that stops a second replica
 * repeating the handler's effect (`backend/CLAUDE.md`: "A new cron fills in
 * that column"). Every replica fires every cron, so each handler has an
 * answer, even if the answer is that the effect is idempotent.
 *
 * This is a vocabulary check, not a length check: the row must NAME the
 * mechanism -- a claim, a lease, a dedupe key, a conditional `UPDATE`, a lock,
 * an idempotent predicate -- and a long description of what the job does
 * without one still fails. The stems are mechanism words only; a filler word
 * added here to let a row through would turn the check back into prose.
 * A row that said only "Weekly budget digest" hid a cron that emailed every
 * user once per replica, and nothing noticed until a human did.
 */
export const REPLICA_MECHANISM_VOCABULARY = new RegExp(
  [
    // Claim rows and leases (`claimOnce`, `claimLease`, `withLease`, a
    // conditional claim).
    String.raw`\bclaim(?:ed|s|Once|Lease)?\b`,
    String.raw`\b(?:with)?lease[ds]?\b`,
    // Dedupe keys and unique indexes that make the second insert a no-op.
    String.raw`\bdedupe(?:d|_key)?\b`,
    String.raw`\bunique index\b`,
    String.raw`\binsert[- ]winner\b`,
    String.raw`\bON CONFLICT\b`,
    String.raw`\bupsert(?:s|ed)?\b`,
    // Conditional writes that re-evaluate their predicate under the row lock.
    String.raw`\bRETURNING\b`,
    String.raw`\bcompare-and-set\b`,
    String.raw`\bconditional \x60?UPDATE\b`,
    String.raw`\bSKIP LOCKED\b`,
    String.raw`\bFOR UPDATE\b`,
    String.raw`\block(?:ed|s)?\b`,
    String.raw`\badvisory\b`,
    // Effects a second run cannot repeat because they converge.
    String.raw`\bidempotent\b`,
    String.raw`\bpredicate\b`,
    String.raw`\bat most once\b`,
    String.raw`\bexactly once\b`,
  ].join("|"),
  "i",
);

/**
 * Rows whose Purpose names no mechanism, as `stem (schedule): <first 60
 * chars>` so the failure says which row to fix without opening the file.
 */
export function rowsWithoutReplicaMechanism(entries: CronDocEntry[]): string[] {
  return entries
    .filter(({ purpose }) => !REPLICA_MECHANISM_VOCABULARY.test(purpose))
    .map(
      ({ stem, schedule, purpose }) =>
        `${stem} (${schedule}): ${purpose.slice(0, 60) || "<no Purpose cell>"}`,
    );
}

/**
 * Per-stem comparison of documented against declared schedules, as sorted
 * multisets. Returns human-readable discrepancies; empty means the table tells
 * the truth.
 */
export function scheduleDiscrepancies(
  declared: Map<string, StemSchedules>,
  documented: Map<string, string[]>,
): string[] {
  const out: string[] = [];
  for (const [stem, { schedules }] of declared) {
    const doc = documented.get(stem);
    if (!doc) continue; // membership is its own test with its own message
    const want = [...schedules].sort();
    const have = [...doc].sort();
    if (JSON.stringify(want) !== JSON.stringify(have)) {
      out.push(
        `${stem}: source declares [${want.join("; ")}], doc says [${have.join("; ")}]`,
      );
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// The grammar, pinned.
// ---------------------------------------------------------------------------

describe("cron doc grammar", () => {
  it("parses literal expressions, options and timezones", () => {
    const parsed = parseCronDecorators(
      [
        `  @Cron("0 17 * * 1-5", { timeZone: "America/New_York" })`,
        `  async prices() {}`,
        `  @Cron('30 * * * *')`,
        `  async holdings() {}`,
      ].join("\n"),
    );
    expect(parsed.schedules).toEqual([
      "0 17 * * 1-5 (America/New_York)",
      "30 * * * *",
    ]);
    expect(parsed.anchors).toBe(2);
    expect(parsed.problems).toEqual([]);
  });

  it("resolves CronExpression members through the installed enum", () => {
    // Resolved via the import, so the doc tracks the scheduler actually
    // running, not a copy of its values.
    const parsed = parseCronDecorators(
      `  @Cron(CronExpression.EVERY_DAY_AT_6AM)`,
    );
    expect(parsed.schedules).toEqual([CronExpression.EVERY_DAY_AT_6AM]);
    expect(
      parseCronDecorators(`  @Cron(CronExpression.NO_SUCH_MEMBER)`).problems,
    ).toHaveLength(1);
  });

  it("counts a decorator it cannot parse, so the mismatch is loud", () => {
    // A template literal (or a variable) is outside the grammar: anchors sees
    // it, schedules does not, and the tree test below fails naming the file.
    const parsed = parseCronDecorators("  @Cron(`0 4 * * *`)\n  async x() {}");
    expect(parsed.anchors).toBe(1);
    expect(parsed.schedules).toEqual([]);
  });

  it("aggregates two files sharing a stem instead of dropping one", () => {
    // Keying a plain object by stem let the second file silently overwrite the
    // first; both of these must survive.
    const byStem = aggregateByStem([
      { path: "backend/src/auth/token.service.ts", schedules: ["0 03 * * *"] },
      { path: "backend/src/other/token.service.ts", schedules: ["0 * * * *"] },
    ]);
    expect(byStem.get("token.service")).toEqual({
      files: [
        "backend/src/auth/token.service.ts",
        "backend/src/other/token.service.ts",
      ],
      schedules: ["0 03 * * *", "0 * * * *"],
    });
  });

  it("accepts a documented stem that is not a .service", () => {
    // The old row grammar required `.service`, so a handler in any other file
    // made the suite unsatisfiable: no legal row could ever document it.
    const rows = parseCronDocRows(
      "| `report.task` | `0 1 * * *` | Daily 1 AM | Nightly report |",
    );
    expect(rows).toEqual([{ stem: "report.task", schedule: "0 1 * * *" }]);
  });

  it("reads a timezone-qualified doc row back to the rendered form", () => {
    const rows = parseCronDocRows(
      "| `exchange-rate.service` | `5 17 * * 1-5` (America/New_York) | 5:05 PM ET weekdays | Fetch rates |",
    );
    expect(rows[0].schedule).toBe("5 17 * * 1-5 (America/New_York)");
  });

  it("reads the Purpose cell, pipes inside it included", () => {
    const [entry] = parseCronDocEntries(
      "| `a.service` | `0 1 * * *` | Daily 1 AM | Purge rows \\| by predicate |",
    );
    expect(entry).toEqual({
      stem: "a.service",
      schedule: "0 1 * * *",
      purpose: "Purge rows \\| by predicate",
    });
    // A row with no fourth cell is read, with an empty Purpose, so the
    // vocabulary check fails it by name instead of never seeing it.
    expect(
      parseCronDocEntries("| `a.service` | `0 1 * * *` | Daily 1 AM |"),
    ).toEqual([{ stem: "a.service", schedule: "0 1 * * *", purpose: "" }]);
  });

  it("fails a Purpose that describes the job without naming a mechanism", () => {
    // The row that hid a cron emailing every user once per replica.
    const entries = parseCronDocEntries(
      [
        "| `budget-alert.service` | `0 7 * * 1` | Mondays 7 AM | Weekly budget digest |",
        "| `budget-alert.service` | `0 7 * * *` | Daily 7 AM | Budget threshold alerts; the fingerprint unique index picks the insert-winner, which alone emails |",
        "| `token.service` | `0 03 * * *` | Daily 3 AM | Expired refresh-token purge, a very long sentence that explains at length what the job does for whom and why it matters |",
        "| `x.service` | `0 1 * * *` | Daily 1 AM | Delete expired rows by predicate |",
      ].join("\n"),
    );
    expect(rowsWithoutReplicaMechanism(entries)).toEqual([
      "budget-alert.service (0 7 * * 1): Weekly budget digest",
      "token.service (0 03 * * *): Expired refresh-token purge, a very long sentence that expla",
    ]);
    // Word stems, not substrings: "blocks" is not a lock, "reclaimed" is
    // not a claim.
    expect(
      REPLICA_MECHANISM_VOCABULARY.test("blocks until reclaimed later"),
    ).toBe(false);
    for (const phrase of [
      "claimOnce(DemoReset, ...)",
      "FetchSyncService.withLease(...) -- the lease",
      "via the dedupe key",
      "a conditional `UPDATE ... RETURNING`",
      "compare-and-set latch",
      "FOR UPDATE SKIP LOCKED",
      "held by one replica per batch with `withLease(...)`",
      "Idempotent across replicas",
    ]) {
      expect(REPLICA_MECHANISM_VOCABULARY.test(phrase)).toBe(true);
    }
  });

  it("reports a documented schedule that contradicts the decorator", () => {
    // The regression this suite exists to catch: the table said midnight
    // daily, the decorator said hourly, and a membership-only check was happy.
    const declared = new Map([
      [
        "accounts.service",
        { files: ["accounts.service.ts"], schedules: ["0 * * * *"] },
      ],
    ]);
    const documented = new Map([["accounts.service", ["0 0 * * *"]]]);
    expect(scheduleDiscrepancies(declared, documented)).toEqual([
      "accounts.service: source declares [0 * * * *], doc says [0 0 * * *]",
    ]);
    expect(
      scheduleDiscrepancies(
        declared,
        new Map([["accounts.service", ["0 * * * *"]]]),
      ),
    ).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The tree itself.
// ---------------------------------------------------------------------------

const REPO_ROOT = findRepoRoot(__dirname);

const describeTree = REPO_ROOT || process.env.CI ? describe : describe.skip;

describeTree(
  "docs/cron-jobs.md matches the @Cron handlers in the source",
  () => {
    interface TreeData {
      declared: Map<string, StemSchedules>;
      unparseable: string[];
      documented: Map<string, string[]>;
      rowCount: number;
      entries: CronDocEntry[];
    }
    let cached: TreeData | undefined;

    const load = (): TreeData => {
      if (cached) return cached;
      const root = requireRepoRoot(REPO_ROOT);
      const sources = gitListFiles(root, "-- backend/src").filter(
        (f) => f.endsWith(".ts") && !f.endsWith(".spec.ts"),
      );
      const unparseable: string[] = [];
      const parsedFiles = sources.map((path) => {
        const parsed = parseCronDecorators(
          readFileSync(join(root, path), "utf8"),
        );
        if (
          parsed.anchors !== parsed.schedules.length ||
          parsed.problems.length
        ) {
          unparseable.push(
            `${path}: ${parsed.anchors} @Cron line(s), ${parsed.schedules.length} parsed${
              parsed.problems.length ? `; ${parsed.problems.join("; ")}` : ""
            }`,
          );
        }
        return { path, schedules: parsed.schedules };
      });
      const declared = aggregateByStem(parsedFiles);
      const entries = parseCronDocEntries(
        readFileSync(join(root, "docs", "cron-jobs.md"), "utf8"),
      );
      const rows = entries.map(({ stem, schedule }) => ({ stem, schedule }));
      const documented = new Map<string, string[]>();
      for (const { stem, schedule } of rows) {
        documented.set(stem, [...(documented.get(stem) ?? []), schedule]);
      }
      cached = {
        declared,
        unparseable,
        documented,
        rowCount: rows.length,
        entries,
      };
      return cached;
    };

    it("finds handlers and rows at all, so the comparisons are not vacuous", () => {
      // Either side reading empty would make every assertion below pass.
      const { declared, documented, rowCount } = load();
      expect(declared.size).toBeGreaterThan(10);
      expect(documented.size).toBeGreaterThan(10);
      expect(rowCount).toBeGreaterThanOrEqual(20);
      expect(declared.has("auto-backup.service")).toBe(true);
    });

    it("parses every @Cron decorator it counts", () => {
      // A decorator outside the grammar must be a red test naming the file, not
      // a row that quietly never gets demanded.
      expect(load().unparseable).toEqual([]);
    });

    it("documents every service that declares a @Cron handler", () => {
      const { declared, documented } = load();
      const undocumented = [...declared.keys()]
        .filter((stem) => !documented.has(stem))
        .sort();
      // A scheduled job nobody knows about is one nobody checks the RLS context,
      // the multi-replica behaviour or the failure mode of.
      expect(undocumented).toEqual([]);
    });

    it("names no service that has stopped having one", () => {
      const { declared, documented } = load();
      const stale = [...documented.keys()]
        .filter((stem) => !declared.has(stem))
        .sort();
      // `auth.service` sat here after its @Cron moved to `token.service`, so the
      // table pointed at a file with no schedule in it.
      expect(stale).toEqual([]);
    });

    it("documents each handler's exact expression, timezone included", () => {
      // One row per handler, expression compared verbatim: this is what stops
      // the table claiming midnight for an hourly job, or reading complete when
      // a service quietly grew a second schedule.
      const { declared, documented } = load();
      expect(scheduleDiscrepancies(declared, documented)).toEqual([]);
    });

    it("names, for every handler, what stops a second replica repeating its effect", () => {
      // Every replica fires every cron, so every row has an answer to give --
      // a claim, a lease, a dedupe key, a conditional write, or an idempotent
      // predicate. No allowlist: a row that names none is fixed, not excused.
      const { entries } = load();
      // Vacuity anchor: an empty or misparsed table would pass the filter.
      expect(entries.length).toBeGreaterThanOrEqual(20);
      expect(entries.every(({ purpose }) => purpose.length > 0)).toBe(true);
      expect(rowsWithoutReplicaMechanism(entries)).toEqual([]);
    });
  },
);
