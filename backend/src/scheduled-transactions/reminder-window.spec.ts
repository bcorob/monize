import { readFileSync } from "node:fs";
import { join } from "node:path";
import { validate } from "class-validator";
import { plainToInstance } from "class-transformer";
import { findRepoRoot, requireRepoRoot } from "../common/repo-tree.util";
import {
  MAX_REMINDER_DAYS_BEFORE,
  reminderWindowThrough,
} from "./reminder-window";
import { CreateScheduledTransactionDto } from "./dto/create-scheduled-transaction.dto";
import {
  OCCURRENCE_HORIZON_MAX_DAYS,
  ScheduledOccurrencesQueryDto,
} from "./dto/scheduled-occurrences-query.dto";
import { expandOccurrenceSlots } from "../common/scheduled-occurrences";

/**
 * A reminder window is a date range, and every way of producing a non-date one is
 * closed.
 *
 * The defect: `reminder_days_before` was unbounded, so a value past `Date`'s
 * range made `addDaysYMD` return the literal string "NaN-NaN-NaN".
 * `expandOccurrenceSlots` compares window bounds as text, and
 * `"2026-08-26" <= "NaN-NaN-NaN"` is true because digits sort before letters --
 * so the expander reported every occurrence of every bill as falling inside
 * today's reminder window, walked each schedule to its 2000-step guard, and the
 * daily cron every tenant shares emailed reminders for bills due years out, every
 * day. Three independent closures, one per test group below.
 */
describe("reminder window", () => {
  const today = "2026-08-26";

  describe("the window bound", () => {
    it("treats a null notice period as due-today-only", () => {
      // Nullable column. `addDaysYMD(today, null)` happens to return today
      // (`n + null === n`), but the caller must not depend on that arithmetic.
      expect(reminderWindowThrough(today, null)).toBe(today);
      expect(reminderWindowThrough(today, undefined)).toBe(today);
    });

    it("keeps an ordinary notice period", () => {
      expect(reminderWindowThrough(today, 3)).toBe("2026-08-29");
    });

    it("clamps a value that would overflow the date range", () => {
      // The stored value that produced "NaN-NaN-NaN".
      expect(reminderWindowThrough(today, 100_000_000)).toBe(
        reminderWindowThrough(today, MAX_REMINDER_DAYS_BEFORE),
      );
      expect(reminderWindowThrough(today, 100_000_000)).toMatch(
        /^\d{4}-\d{2}-\d{2}$/,
      );
    });

    it("refuses to look backwards", () => {
      expect(reminderWindowThrough(today, -30)).toBe(today);
    });
  });

  describe("the DTO", () => {
    const dtoFor = (reminderDaysBefore: unknown) =>
      plainToInstance(CreateScheduledTransactionDto, {
        name: "Rent",
        accountId: "11111111-1111-1111-1111-111111111111",
        amount: -1200,
        frequency: "MONTHLY",
        nextDueDate: "2026-09-01",
        reminderDaysBefore,
      });

    const errorsFor = async (value: unknown) =>
      (await validate(dtoFor(value))).filter(
        (e) => e.property === "reminderDaysBefore",
      );

    it("accepts a sane notice period", async () => {
      expect(await errorsFor(3)).toHaveLength(0);
      expect(await errorsFor(MAX_REMINDER_DAYS_BEFORE)).toHaveLength(0);
    });

    it("rejects a value past the ceiling", async () => {
      expect(await errorsFor(MAX_REMINDER_DAYS_BEFORE + 1)).not.toHaveLength(0);
      expect(await errorsFor(100_000_000)).not.toHaveLength(0);
    });

    it("rejects a fraction, which an INTEGER column cannot store", async () => {
      expect(await errorsFor(0.5)).not.toHaveLength(0);
    });

    it("rejects a negative notice period", async () => {
      expect(await errorsFor(-1)).not.toHaveLength(0);
    });
  });

  describe("the column", () => {
    const schema = readFileSync(
      join(requireRepoRoot(findRepoRoot(__dirname)), "database/schema.sql"),
      "utf8",
    );

    it("carries the same ceiling as the code, in both directions", () => {
      // The DTO is the API's door and the CHECK is the column's; a bound written
      // twice drifts, so the number is asserted against the schema rather than
      // trusted. `database/migrations/165_clamp_reminder_days_before.sql` adds the
      // same constraint to an existing database and normalizes the rows written
      // before it -- without that, a legacy row above the ceiling made every later
      // save of that schedule fail validation.
      const check = schema.match(
        /CONSTRAINT chk_scheduled_reminder_days_before CHECK \(\s*reminder_days_before IS NULL OR \(reminder_days_before BETWEEN 0 AND (\d+)\)\s*\)/,
      );
      expect(check).not.toBeNull();
      expect(Number(check![1])).toBe(MAX_REMINDER_DAYS_BEFORE);
    });

    it("has a migration that normalizes the rows written before the bound", () => {
      const migration = readFileSync(
        join(
          requireRepoRoot(findRepoRoot(__dirname)),
          "database/migrations/165_clamp_reminder_days_before.sql",
        ),
        "utf8",
      );
      expect(migration).toContain(
        `SET reminder_days_before = ${MAX_REMINDER_DAYS_BEFORE}`,
      );
      expect(migration).toContain(
        `WHERE reminder_days_before > ${MAX_REMINDER_DAYS_BEFORE}`,
      );
    });
  });

  describe("the occurrences query bound", () => {
    const queryFor = (through: string) =>
      plainToInstance(ScheduledOccurrencesQueryDto, { through });

    const errorsFor = async (through: string) =>
      (await validate(queryFor(through))).filter(
        (e) => e.property === "through",
      );

    const ymdFromNow = (days: number) => {
      const d = new Date();
      d.setUTCHours(0, 0, 0, 0);
      d.setUTCDate(d.getUTCDate() + days);
      return d.toISOString().slice(0, 10);
    };

    it("accepts a real date inside the horizon", async () => {
      expect(await errorsFor(ymdFromNow(90))).toHaveLength(0);
      expect(await errorsFor(ymdFromNow(-30))).toHaveLength(0);
    });

    it("rejects a calendar-impossible date the shape check allowed", async () => {
      // `@Matches(/^\d{4}-\d{2}-\d{2}$/)` passed these, and Postgres then raised
      // "date/time field value out of range" -- a 500 for a client error.
      expect(await errorsFor("9999-99-99")).not.toHaveLength(0);
      expect(await errorsFor("2026-02-30")).not.toHaveLength(0);
      expect(await errorsFor("2026-13-01")).not.toHaveLength(0);
    });

    it("rejects a horizon that turns a cheap request into a full walk", async () => {
      expect(await errorsFor("9999-12-31")).not.toHaveLength(0);
      expect(
        await errorsFor(ymdFromNow(OCCURRENCE_HORIZON_MAX_DAYS + 1)),
      ).not.toHaveLength(0);
      expect(
        await errorsFor(ymdFromNow(OCCURRENCE_HORIZON_MAX_DAYS - 1)),
      ).toHaveLength(0);
    });
  });

  describe("the expander", () => {
    const schedule = {
      frequency: "DAILY" as const,
      // Years away: nowhere near any reminder window.
      nextDueDate: "2030-01-01",
      endDate: null,
      occurrencesRemaining: null,
    };

    it("refuses a window bound that is not a date, rather than matching everything", () => {
      expect(() =>
        expandOccurrenceSlots(schedule, [], {
          from: today,
          through: "NaN-NaN-NaN",
          maxOccurrences: 1,
        }),
      ).toThrow(RangeError);
    });

    it("refuses a non-date lower bound too", () => {
      expect(() =>
        expandOccurrenceSlots(schedule, [], {
          from: "NaN-NaN-NaN",
          through: "2026-09-30",
        }),
      ).toThrow(RangeError);
    });

    it("still answers an ordinary window", () => {
      expect(
        expandOccurrenceSlots(schedule, [], {
          from: today,
          through: "2026-08-31",
          maxOccurrences: 1,
        }),
      ).toEqual([]);
      expect(
        expandOccurrenceSlots(schedule, [], {
          from: "2030-01-01",
          through: "2030-01-02",
        }),
      ).toHaveLength(2);
    });
  });
});
