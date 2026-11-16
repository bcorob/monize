import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from "typeorm";

/**
 * One free-text note over a run of consecutive calendar dates, owned by one user.
 *
 * The exclusion constraint `ex_calendar_day_notes_user_span` is the model: two
 * spans of one user whose inclusive dateranges overlap cannot both exist, so
 * every day is covered by at most one note and "the note covering this day" has
 * one answer. It is declared in SQL rather than here -- TypeORM has no decorator
 * for an EXCLUDE constraint, and the database is where this rule has to hold.
 * It is also the table's only index: it builds a GiST index on exactly
 * `(user_id, span)`, which is the only way the table is read.
 */
@Entity("calendar_day_notes")
export class CalendarDayNote {
  @PrimaryGeneratedColumn("uuid")
  id: string;

  @Column({ type: "uuid", name: "user_id" })
  userId: string;

  /**
   * The first day the note covers, as `YYYY-MM-DD` text, never as an instant.
   */
  @Column({ type: "date", name: "note_date" })
  noteDate: string;

  /** The last day it covers, inclusive; equal to `noteDate` for one day. */
  @Column({ type: "date", name: "end_date" })
  endDate: string;

  @Column({ type: "text" })
  body: string;

  @CreateDateColumn({ name: "created_at" })
  createdAt: Date;

  @UpdateDateColumn({ name: "updated_at" })
  updatedAt: Date;
}
