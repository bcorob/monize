import { IsEnum, IsInt, IsUUID, Max, Min } from "class-validator";

import { ReminderRepeatMode } from "../entities/notification-reminder.entity";
import {
  REMINDER_MAX_INTERVAL_MINUTES,
  REMINDER_MIN_INTERVAL_MINUTES,
} from "../notification-reminder.constants";

/**
 * Ask to be reminded about an existing notification's subject.
 *
 * The notification's content is NOT accepted from the client -- only its id. The
 * service reads that notification under the caller's own scope and copies its
 * type, severity, title, message, data and target into the reminder template, so
 * a reminder cannot carry text the user never saw (the same "content from the
 * server, id from the request" discipline the rest of the codebase keeps).
 */
export class CreateNotificationReminderDto {
  /** The caller's own live notification to nag about. */
  @IsUUID()
  sourceNotificationId: string;

  @IsEnum(ReminderRepeatMode)
  repeatMode: ReminderRepeatMode;

  /**
   * Minutes between fires. The `@Min` is the floor R3 names; the service clamps
   * again server-side so a value that somehow slips past validation is still
   * never fired below the floor.
   */
  @IsInt()
  @Min(REMINDER_MIN_INTERVAL_MINUTES)
  @Max(REMINDER_MAX_INTERVAL_MINUTES)
  intervalMinutes: number;
}
