/**
 * The floor on a reminder's interval, in minutes (R3: "minimum of 5 minutes").
 *
 * A leaf constant so the DTO (`@Min`) and the service (server-side clamp) share
 * one value without importing each other -- the same shape as
 * `THROTTLE_MAX_MINUTES`. A stored value below this is clamped UP, never fired
 * below the floor (INV-REMINDER-002).
 */
export const REMINDER_MIN_INTERVAL_MINUTES = 5;

/**
 * The ceiling on a reminder's interval, in minutes (one week).
 *
 * Bounded like every other user-supplied number in this codebase: an interval
 * of months is not a reminder, and an unbounded integer is a lever. A week is
 * far past a useful nag cadence and far short of anything surprising.
 */
export const REMINDER_MAX_INTERVAL_MINUTES = 7 * 24 * 60;

/**
 * The most active reminders one account may hold.
 *
 * The every-minute cron scans and fires O(active reminders per user), so an
 * uncapped count is a resource lever the same way an unbounded device list or
 * request array is (`MAX_LIVE_DEVICES_PER_USER`, `@ArrayMaxSize`). Fifty is far
 * past a person's real nag count and far short of a useful lever.
 */
export const MAX_ACTIVE_REMINDERS_PER_USER = 50;
