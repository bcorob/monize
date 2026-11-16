import { BadRequestException } from "@nestjs/common";
import { tr } from "../i18n/translate";
import {
  boundedTitle,
  boundedDedupeKey,
  boundedTarget,
  type BoundsLogger,
} from "../notification-center/notification-bounds";

type NotificationRestoreRow = Record<string, unknown> & {
  title: string;
  target?: string | null;
  dedupe_key?: string | null;
};

function invalidNotification(): never {
  throw new BadRequestException(
    tr(
      "errors.backup.invalidNotificationFields",
      "Invalid backup notification: title must be text; target and dedupe key must be text or null",
    ),
  );
}

function assertNotificationRow(
  row: unknown,
): asserts row is NotificationRestoreRow {
  if (!row || typeof row !== "object" || Array.isArray(row))
    invalidNotification();
  const fields = row as Record<string, unknown>;
  if (typeof fields.title !== "string") invalidNotification();
  for (const key of ["target", "dedupe_key"]) {
    if (fields[key] != null && typeof fields[key] !== "string")
      invalidNotification();
  }
}

/** Refuse malformed fields before authentication, staging or destructive SQL. */
export function validateRestoredNotifications(rows: unknown): void {
  // Backups from before the notifications table may omit it.
  if (rows === undefined) return;
  if (!Array.isArray(rows)) invalidNotification();
  for (const row of rows) assertNotificationRow(row);
}

/** The restore keeps its IDs, timestamps and conflict policy, but shares bounds. */
export function boundRestoredNotification(
  row: Record<string, unknown>,
  logger: BoundsLogger,
): Record<string, unknown> {
  assertNotificationRow(row);
  const type =
    typeof row.alert_type === "string"
      ? row.alert_type
      : "restored notification";
  return {
    ...row,
    title: boundedTitle(type, row.title, logger),
    ...("target" in row
      ? { target: boundedTarget(type, row.target, logger) }
      : {}),
    ...("dedupe_key" in row
      ? { dedupe_key: boundedDedupeKey(type, row.dedupe_key, logger) }
      : {}),
  };
}
