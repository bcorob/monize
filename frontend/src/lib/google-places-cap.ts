/**
 * The monthly request cap's default and bounds, mirroring the backend's
 * `GOOGLE_PLACES_CAP` (`backend/src/payees/lookup/google-places/google-places-cap.ts`).
 *
 * Mirrored rather than imported because the two layers cannot import each
 * other, and checked against the backend in both directions by
 * `google-places-cap.contract.test.ts` -- the same arrangement the AI query
 * budgets use, for the same reason: a form that offers a value the server
 * rejects is worse than no form.
 *
 * 1,000 is Google's free monthly allowance for the Text Search Enterprise SKU,
 * which is the SKU a lookup's field mask (websiteUri, internationalPhoneNumber)
 * is billed at. The widely quoted 10,000 belongs to the Essentials SKU, which
 * returns neither field.
 */
export const GOOGLE_PLACES_CAP = {
  default: 1000,
  min: 1,
  max: 1_000_000,
} as const;
