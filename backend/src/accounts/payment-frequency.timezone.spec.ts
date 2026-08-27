import { spawn } from "child_process";
import { readFileSync, readdirSync } from "fs";
import { join } from "path";
import { mortgageTermEndDate } from "./payment-frequency.util";
import { formatDateYMD } from "../common/date-utils";

/**
 * A payoff date is the same calendar day in every deployment.
 *
 * CI runs `TZ=UTC` and so does every other spec in this directory, which is
 * exactly why this class of defect survives review: `advancePaymentDates` read
 * LOCAL date components off a `Date` its callers build from a date-only string
 * (`new Date("2026-01-15")` is UTC midnight) and returned a LOCAL-midnight
 * `Date` that `formatDateYMD` then read back in UTC. Every payoff date came out
 * one day early outside UTC, by two different routes -- west of Greenwich the
 * input read landed on the previous day, east of it the output did -- so the
 * linked scheduled transaction's `endDate` fell a day before its own final
 * occurrence and the last payment never posted.
 *
 * The rule the code follows: a `Date` carrying a calendar date is UTC-midnight
 * here, the convention `ensureYMD` and `formatDateYMD` already share.
 *
 * **A same-offset test cannot demonstrate an offset property.** Setting
 * `process.env.TZ` inside a Jest worker does not move `Date` -- the sandbox's
 * `process.env` write never reaches V8's timezone cache, so the whole matrix
 * passes against deliberately broken code (verified). The offsets are therefore
 * walked in child processes, which is the only place `TZ` is read: same family
 * as "a mocked filesystem cannot demonstrate a filesystem property".
 *
 * The source scan below is the cheap generalisation -- it fails for a local
 * getter anywhere in these modules, including at a call site this spec does not
 * exercise.
 */

/** UTC is the control; the other two are the halves of the original defect. */
const OFFSETS = ["UTC", "Europe/Warsaw", "America/New_York"];

/**
 * What each child computes: label -> expected `YYYY-MM-DD`. Every value is a
 * date the recurrence engine itself reaches, so the expectation is the schedule
 * the borrower is actually posted.
 */
const CASES: Record<string, string> = {
  // Payment 1 on the 15th, twelve monthly payments: the twelfth is 2026-12-15.
  "loan monthly": "2026-12-15",
  // The clamping cadence, where a day's drift also changes which month the
  // clamp lands in on the next step.
  "loan month-end": "2027-01-28",
  "mortgage accelerated biweekly": "2026-12-31",
  // The 15th and the last day of the month: two anchors a day's drift moves
  // between, so a shifted input picks the other branch rather than the same
  // branch a day out.
  "semi-monthly": "2027-01-15",
  // A sentinel is still a date somebody screenshots.
  "never pays off": "2126-01-15",
  // The degenerate case still crosses both conversions -- the cheapest proof
  // that the round trip itself is offset-free.
  "zero steps": "2026-01-15",
  // A five-year-and-one-month term from a month-end anchor, as PostgreSQL
  // receives it: the clamp lands on the last day of February, where `setMonth`
  // would have overflowed into March.
  //
  // Asserted through TypeORM's own serializer rather than `formatDateYMD`,
  // because that is the only thing this value is ever handed to. The two read
  // opposite components -- `formatDateYMD` UTC, a `date` column local -- so a
  // value can be right for one and a day out for the other, and asserting the
  // wrong one is exactly how the stored term end went unnoticed. The same for
  // the start date, which anchors every later amortization.
  "term end stored": "2031-02-28",
  "start date stored": "2026-01-31",
};

const CHILD_SCRIPT = `
const { calculateEndDate } = require("./src/accounts/loan-amortization.util");
const { calculateMortgageEndDate } = require("./src/accounts/mortgage-amortization.util");
const { advancePaymentDates, mortgageTermEndDate } = require("./src/accounts/payment-frequency.util");
const { localDateForColumn } = require("./src/common/date-utils");
const { DateUtils } = require("typeorm/util/DateUtils");
const { formatDateYMD } = require("./src/common/date-utils");
const f = formatDateYMD;
process.stdout.write(JSON.stringify({
  "loan monthly": f(calculateEndDate(new Date("2026-01-15"), "MONTHLY", 12)),
  "loan month-end": f(calculateEndDate(new Date("2026-01-31"), "MONTHLY", 13)),
  "mortgage accelerated biweekly": f(
    calculateMortgageEndDate(new Date("2026-01-15"), "ACCELERATED_BIWEEKLY", 26),
  ),
  "semi-monthly": f(advancePaymentDates(new Date("2026-01-15"), "SEMIMONTHLY", 24)),
  "never pays off": f(calculateEndDate(new Date("2026-01-15"), "MONTHLY", Infinity)),
  "zero steps": f(advancePaymentDates(new Date("2026-01-15"), "MONTHLY", 0)),
  // What PostgreSQL actually receives for a DATE column, which TypeORM
  // serializes with LOCAL getters -- so this is the assertion that the stored
  // value is right, not merely the computed one.
  "term end stored": DateUtils.mixedDateToDateString(
    mortgageTermEndDate(new Date("2026-01-31"), 61),
  ),
  "start date stored": DateUtils.mixedDateToDateString(
    localDateForColumn("2026-01-31"),
  ),
}));
`;

const BACKEND_ROOT = join(__dirname, "..", "..");

function datesUnder(timezone: string): Promise<Record<string, string>> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["-r", "ts-node/register/transpile-only", "-e", CHILD_SCRIPT],
      {
        cwd: BACKEND_ROOT,
        env: { ...process.env, TZ: timezone, TS_NODE_TRANSPILE_ONLY: "true" },
      },
    );
    let out = "";
    let err = "";
    child.stdout.on("data", (chunk) => (out += chunk));
    child.stderr.on("data", (chunk) => (err += chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`TZ=${timezone} child exited ${code}: ${err}`));
        return;
      }
      try {
        resolve(JSON.parse(out));
      } catch {
        reject(
          new Error(`TZ=${timezone} child printed non-JSON: ${out}${err}`),
        );
      }
    });
  });
}

describe("payment dating is independent of the container timezone", () => {
  // Three ts-node startups; run together rather than in series.
  it("dates every cadence the same in UTC, east of it and west of it", async () => {
    const answers = await Promise.all(OFFSETS.map(datesUnder));
    const byOffset = Object.fromEntries(
      OFFSETS.map((tz, i) => [tz, answers[i]]),
    );
    expect(byOffset).toEqual(
      Object.fromEntries(OFFSETS.map((tz) => [tz, CASES])),
    );
  }, 60_000);
});

/**
 * The generalisation: in these three modules a `Date` is a calendar date, so
 * only the UTC accessors may touch one. A local getter here is the defect above
 * however it is spelled, and it is mechanical enough to scan for.
 */
describe("the amortization date helpers read UTC components only", () => {
  const SUBJECTS = [
    "payment-frequency.util.ts",
    "loan-amortization.util.ts",
    "mortgage-amortization.util.ts",
    "amortization-count.util.ts",
  ];

  /** `getMonth(`, `setFullYear(` and friends -- the local half of each pair. */
  const LOCAL_ACCESSOR =
    /\.(get|set)(FullYear|Month|Date|Day|Hours|Minutes|Seconds|Milliseconds)\s*\(/g;

  /** Comment lines only, so prose naming the mistake does not count as it. */
  function code(source: string): string {
    return source
      .split("\n")
      .filter((line) => !/^\s*(\/\/|\/\*|\*)/.test(line))
      .join("\n");
  }

  /**
   * The other half of the same rule, and the opposite direction.
   *
   * A `Date` bound for a TypeORM `date` COLUMN must be LOCAL midnight, because
   * `DateUtils.mixedDateToDateString` reads local components -- so
   * `new Date("2026-01-31")` (UTC midnight) is stored as the 30th west of
   * Greenwich. `localDateForColumn` is the one door; a bare `new Date(...)` on
   * one of these two properties is the defect, and it anchors every amortization
   * the account later computes.
   */
  it("builds no date-column value with a bare new Date()", () => {
    const COLUMN_DATE_ASSIGNMENT =
      /\b(paymentStartDate|termEndDate)\s*[:=]\s*new Date\(/g;
    const offenders = readdirSync(join(__dirname, "..", "accounts"))
      .filter((file) => file.endsWith(".ts") && !file.endsWith(".spec.ts"))
      .map(
        (file) =>
          [file, readFileSync(join(__dirname, file), "utf8")] as [
            string,
            string,
          ],
      )
      .filter(([, source]) => COLUMN_DATE_ASSIGNMENT.test(code(source)))
      .map(([file]) => file);
    expect(offenders).toEqual([]);

    // And the pattern matches what it claims to.
    expect(
      /\b(paymentStartDate|termEndDate)\s*[:=]\s*new Date\(/.test(
        "paymentStartDate: new Date(dto.nextDueDate),",
      ),
    ).toBe(true);
    expect(
      /\b(paymentStartDate|termEndDate)\s*[:=]\s*new Date\(/.test(
        "paymentStartDate: localDateForColumn(dto.nextDueDate),",
      ),
    ).toBe(false);
  });

  it.each(SUBJECTS)("%s uses no local date accessor", (file) => {
    // `readFileSync` throws when the file moves, which is the failure we want:
    // a scan whose subject vanished must not report "no offenders".
    const source = readFileSync(join(__dirname, file), "utf8");
    expect(code(source).match(LOCAL_ACCESSOR) ?? []).toEqual([]);
  });

  it("would catch a local accessor, so the scan cannot pass by accident", () => {
    const offending = code(
      ["export function f(d: Date) {", "  return d.getFullYear();", "}"].join(
        "\n",
      ),
    );
    expect(offending.match(LOCAL_ACCESSOR)).toHaveLength(1);
    // And the UTC spelling is not reported.
    const fine = code(
      [
        "export function f(d: Date) {",
        "  return d.getUTCFullYear();",
        "}",
      ].join("\n"),
    );
    expect(fine.match(LOCAL_ACCESSOR)).toBeNull();
  });
});

/**
 * A mortgage's term end is a single clamped month offset from the first payment,
 * not an accumulation and not `Date.setMonth`.
 *
 * Three services computed it, all three the same way -- `d.setMonth(d.getMonth()
 * + termMonths)` on a `Date` built from a date-only string. That is two defects
 * in one line: local accessors on a UTC-midnight instant (the day moves with the
 * container's offset) and `setMonth`'s overflow where the scheduler's own
 * calendar clamps.
 */
describe("mortgageTermEndDate", () => {
  it("clamps a month-end anchor instead of overflowing it", () => {
    // The plain wrong answer this replaced: `new Date(Date.UTC(2026, 0, 31))`
    // with `setMonth(+1)` gives 3 March.
    expect(formatDateYMD(mortgageTermEndDate(new Date("2026-01-31"), 1))).toBe(
      "2026-02-28",
    );
    expect(formatDateYMD(mortgageTermEndDate(new Date("2028-01-31"), 1))).toBe(
      "2028-02-29",
    );
    expect(formatDateYMD(mortgageTermEndDate(new Date("2026-01-31"), 3))).toBe(
      "2026-04-30",
    );
  });

  it("offsets from the anchor rather than accumulating clamped steps", () => {
    // Sixty accumulating monthly steps from 31 January clamp to the 28th at the
    // first February and stay there; a five-year TERM ends on the 31st.
    expect(formatDateYMD(mortgageTermEndDate(new Date("2026-01-31"), 60))).toBe(
      "2031-01-31",
    );
  });

  it("leaves an ordinary anchor alone", () => {
    expect(formatDateYMD(mortgageTermEndDate(new Date("2026-03-15"), 60))).toBe(
      "2031-03-15",
    );
    expect(formatDateYMD(mortgageTermEndDate(new Date("2026-03-15"), 0))).toBe(
      "2026-03-15",
    );
  });
});
