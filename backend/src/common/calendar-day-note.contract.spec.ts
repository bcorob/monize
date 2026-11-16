import { readFileSync } from "fs";
import { join } from "path";
import "reflect-metadata";
import { plainToInstance } from "class-transformer";
import { validateSync } from "class-validator";

import {
  CALENDAR_DAY_NOTE_MAX_LENGTH,
  CALENDAR_DAY_NOTE_MAX_SPAN_DAYS,
} from "./calendar-day-note";
import { UpsertDayNoteDto } from "../calendar/dto/upsert-day-note.dto";

/**
 * A day note has ONE length, in three places, and they are three different
 * kinds of enforcement: the form that stops the user typing, the DTO that
 * refuses the save, and the CHECK constraint that refuses the row.
 *
 * They fail in three different ways when they disagree, and each is worse than
 * the last. A frontend cap below the server's truncates text a user may
 * legitimately store. A frontend cap above it lets the form accept a save the
 * server rejects with nothing pointing at the field. And a DTO cap above the
 * database's turns a valid-looking request into a constraint violation from
 * inside the transaction -- a 500 for what is plainly a client error.
 */
const repoRoot = join(__dirname, "..", "..", "..");

describe("the calendar day note length", () => {
  it("is the number the frontend stops typing at", () => {
    const frontend = readFileSync(
      join(repoRoot, "frontend/src/lib/calendar-day-note.ts"),
      "utf8",
    );
    const declared = frontend.match(/CALENDAR_DAY_NOTE_MAX_LENGTH\s*=\s*(\d+)/);
    expect(declared).not.toBeNull();
    expect(Number(declared![1])).toBe(CALENDAR_DAY_NOTE_MAX_LENGTH);
  });

  it("is the number the database enforces", () => {
    const schema = readFileSync(join(repoRoot, "database/schema.sql"), "utf8");
    const check = schema.match(
      /ck_calendar_day_notes_body_length CHECK \(char_length\(body\) BETWEEN (\d+) AND (\d+)\)/,
    );
    expect(check).not.toBeNull();
    // The lower bound matters too: it is what makes a blank body impossible
    // even on a path that skipped the DTO.
    expect(Number(check![1])).toBe(1);
    expect(Number(check![2])).toBe(CALENDAR_DAY_NOTE_MAX_LENGTH);
  });

  it("is carried by the migration that creates the table, not only by schema.sql", () => {
    // A fresh install reads schema.sql and an existing one reads the migration;
    // a constraint in one and not the other is a difference between two
    // databases that are supposed to be the same.
    const migration = readFileSync(
      join(
        repoRoot,
        "database/migrations/20260912034642_calendar_day_notes.sql",
      ),
      "utf8",
    );
    expect(migration).toContain(
      `CHECK (char_length(body) BETWEEN 1 AND ${CALENDAR_DAY_NOTE_MAX_LENGTH})`,
    );
    expect(migration).toContain(
      "CONSTRAINT uq_calendar_day_notes_user_date UNIQUE (user_id, note_date)",
    );
    // The policy and the enable ship with the table, or the table is
    // unprotected under enforcement (database/CLAUDE.md).
    expect(migration).toContain(
      "ALTER TABLE calendar_day_notes ENABLE ROW LEVEL SECURITY",
    );
    expect(migration).toContain("CREATE POLICY calendar_day_notes_isolation");
    // USING alone filters READS and permits writing a row owned by anyone: the
    // uniform direct-bucket policy carries both arms, and a migration that
    // shipped only USING would leave the table's writes unpoliced under
    // enforcement. scripts/verify-schema.sh is what caught the omission.
    expect(migration).toContain(
      "WITH CHECK (user_id = (SELECT app_current_user_id()) OR (SELECT app_bypass_rls()))",
    );
  });

  it("is what the validator actually enforces, at both ends", () => {
    const at = (length: number) =>
      validateSync(
        plainToInstance(UpsertDayNoteDto, { body: "x".repeat(length) }),
      );
    expect(at(1)).toEqual([]);
    expect(at(CALENDAR_DAY_NOTE_MAX_LENGTH)).toEqual([]);
    expect(at(CALENDAR_DAY_NOTE_MAX_LENGTH + 1)).not.toEqual([]);
    expect(at(0)).not.toEqual([]);
  });

  it("is spelled out nowhere but the two constants", () => {
    // The number in a DTO decorator or a form's maxLength is how the three
    // copies drift apart; both layers import it instead.
    const backendDto = readFileSync(
      join(__dirname, "..", "calendar/dto/upsert-day-note.dto.ts"),
      "utf8",
    );
    expect(backendDto).toContain("CALENDAR_DAY_NOTE_MAX_LENGTH");
    expect(backendDto).not.toMatch(
      new RegExp(`MaxLength\\(\\s*${CALENDAR_DAY_NOTE_MAX_LENGTH}\\s*\\)`),
    );
  });
});

/**
 * A note's span has ONE bound, in three places, for the reason its length does:
 * the form that stops the user extending it, the resolver that refuses the
 * save, and the CHECK constraint that refuses the row.
 *
 * The CHECK counts the days BEYOND the first (`end_date - note_date`), which is
 * the same number both constants carry; a note therefore covers at most that
 * many days plus one.
 */
describe("the calendar day note span", () => {
  it("is the number the frontend stops extending at", () => {
    const frontend = readFileSync(
      join(repoRoot, "frontend/src/lib/calendar-day-note.ts"),
      "utf8",
    );
    const declared = frontend.match(
      /CALENDAR_DAY_NOTE_MAX_SPAN_DAYS\s*=\s*(\d+)/,
    );
    expect(declared).not.toBeNull();
    expect(Number(declared![1])).toBe(CALENDAR_DAY_NOTE_MAX_SPAN_DAYS);
  });

  it("is the number the database enforces", () => {
    const schema = readFileSync(join(repoRoot, "database/schema.sql"), "utf8");
    const check = schema.match(
      /ck_calendar_day_notes_span CHECK \(end_date >= note_date AND end_date - note_date <= (\d+)\)/,
    );
    expect(check).not.toBeNull();
    expect(Number(check![1])).toBe(CALENDAR_DAY_NOTE_MAX_SPAN_DAYS);
  });

  it("is carried by the migration that adds the column, not only by schema.sql", () => {
    const migration = readFileSync(
      join(
        repoRoot,
        "database/migrations/20260912200152_calendar_day_note_spans.sql",
      ),
      "utf8",
    );
    expect(migration).toContain(
      `CHECK (end_date >= note_date AND end_date - note_date <= ${CALENDAR_DAY_NOTE_MAX_SPAN_DAYS})`,
    );
  });

  it("is guarded by the exclusion constraint in both schema.sql and the migration", () => {
    // Non-overlap is what makes "the note covering this day" a question with
    // one answer, and it is the reason the old UNIQUE is gone. A fresh install
    // reads schema.sql and an upgraded one reads the migration; the constraint
    // in one and not the other is two databases that are supposed to be one.
    const schema = readFileSync(join(repoRoot, "database/schema.sql"), "utf8");
    const migration = readFileSync(
      join(
        repoRoot,
        "database/migrations/20260912200152_calendar_day_note_spans.sql",
      ),
      "utf8",
    );
    for (const sql of [schema, migration]) {
      expect(sql).toContain("CREATE EXTENSION IF NOT EXISTS btree_gist");
      expect(sql).toMatch(
        /ex_calendar_day_notes_user_span[\s\S]*EXCLUDE USING gist[\s\S]*user_id WITH =[\s\S]*daterange\(note_date, end_date, '\[\]'\) WITH &&/,
      );
    }
    // The per-date UNIQUE said a thing that spans make untrue, so it is gone
    // from the live schema and dropped by the migration.
    expect(schema).not.toContain("uq_calendar_day_notes_user_date");
    expect(migration).toContain(
      "DROP CONSTRAINT IF EXISTS uq_calendar_day_notes_user_date",
    );
  });
});
