import { DataSource } from "typeorm";
import { UserPreference } from "../users/entities/user-preference.entity";
import { withScopedDb } from "./db/scoped-db";

/**
 * The currency a reader's totals are expressed in when they have expressed no
 * preference.
 *
 * It is a fallback, not a default in any meaningful sense: every aggregate has
 * to be denominated in *something* to be printable, and a user whose preference
 * row is missing entirely has stated nothing. `USD` because that is what
 * `UserPreference.defaultCurrency` itself defaults to -- the fallback and the
 * column must agree, or the same user reads one currency before their row exists
 * and another after.
 *
 * It is held here because the copies had already drifted: twelve sites spelled
 * this out, ten said `USD`, two said `CAD`, and one used `??` (which accepts the
 * empty string a cleared select stores as if it were a currency). Net Worth and
 * Portfolio therefore reported the same user's money in two currencies, with no
 * conversion between them and nothing on either screen to say so.
 */
export const FALLBACK_DEFAULT_CURRENCY = "USD";

/**
 * The reporting currency for a preference row already in hand.
 *
 * `defaultCurrency` is nullable and can be the empty string (a cleared select),
 * and neither is a currency -- so the test is truthiness, not `?? `.
 */
export function preferredCurrency(
  pref: { defaultCurrency?: string | null } | null | undefined,
): string {
  return pref?.defaultCurrency || FALLBACK_DEFAULT_CURRENCY;
}

/**
 * The user's reporting currency, read for its own sake.
 *
 * Use this where the preference row is wanted for nothing else; where a caller
 * already loaded it for other fields, call `preferredCurrency(pref)` rather than
 * issuing a second query. `default-currency.guard.spec.ts` fails on a fifth
 * hand-rolled copy of the fallback.
 */
export async function resolveUserDefaultCurrency(
  dataSource: DataSource,
  userId: string,
): Promise<string> {
  const pref = await withScopedDb(dataSource, (m) =>
    m.getRepository(UserPreference).findOne({ where: { userId } }),
  );
  return preferredCurrency(pref);
}
