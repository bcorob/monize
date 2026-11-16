/**
 * The canonical 8-4-4-4-12 hex form, any version, either case. Mirrors the
 * backend's `@IsUUID` / `ParseUUIDPipe` shape closely enough that a value this
 * rejects would be a 4xx there.
 */
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Whether `value` is a UUID, so it can be sent to the server as an id. */
export function isUuid(value: string | null | undefined): value is string {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}
