/**
 * The monthly request cap: its default and the range a stored one may occupy.
 *
 * Declared once because four places have to agree about it -- the CHECK
 * constraint in migration 188, the DTO's `@Min`/`@Max`, the operator's
 * `GOOGLE_PLACES_MONTHLY_CAP` default, and the number the settings form offers
 * -- and a bound spelled out per site is how the AI query budgets drifted
 * before they were declared as data (`ai/query/query-budgets.ts`).
 *
 * **1,000, not 10,000.** Google's free monthly allowances are per SKU, and a
 * Text Search whose field mask asks for `websiteUri` or
 * `internationalPhoneNumber` is billed at the Text Search Enterprise SKU,
 * whose free allowance is 1,000 requests per calendar month. The widely quoted
 * 10,000 belongs to the Essentials SKU, which returns neither a website nor a
 * phone number and so cannot answer this lookup at all.
 */
export const GOOGLE_PLACES_CAP = {
  default: 1000,
  min: 1,
  max: 1_000_000,
} as const;

/**
 * The zone whose calendar month the cap is counted in.
 *
 * **Google's, not ours.** The free monthly allowance resets on the first day of
 * each month at midnight Pacific US time, so a counter that rolled over at UTC
 * midnight released the user's whole cap seven or eight hours BEFORE Google
 * released the allowance it is rationing. In that window every request is
 * counted by us against a fresh month and by Google against the old one -- so a
 * user who spends the cap in it pays for the overage, which is the one outcome
 * a cap exists to prevent.
 *
 * A named zone rather than a fixed offset, because Pacific observes DST and
 * PostgreSQL's tzdata already knows when: the boundary is 08:00 UTC in winter
 * and 07:00 in summer, and hard-coding either is wrong for half the year.
 *
 * Passed as a bind parameter to `AT TIME ZONE` rather than interpolated, so the
 * statement stays parameterized like every other in this codebase.
 */
export const GOOGLE_PLACES_QUOTA_TIMEZONE = "America/Los_Angeles";

/**
 * A stored cap outside the range falls back to the default rather than being
 * clamped: a value the database should never have held is a fault, and
 * clamping it silently substitutes a limit nobody chose. Same rule as
 * `resolveQueryBudgetsForConfig`.
 */
export function resolveMonthlyCap(stored: number | null | undefined): number {
  if (typeof stored !== "number" || !Number.isInteger(stored)) {
    return GOOGLE_PLACES_CAP.default;
  }
  return stored >= GOOGLE_PLACES_CAP.min && stored <= GOOGLE_PLACES_CAP.max
    ? stored
    : GOOGLE_PLACES_CAP.default;
}
