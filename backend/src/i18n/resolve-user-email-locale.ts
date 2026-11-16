import { Repository } from "typeorm";
import { UserPreference } from "../users/entities/user-preference.entity";
import { isSupportedLocale } from "./config";
import { currentRequestLocale } from "./request-locale";

/**
 * Resolve the locale a message addressed to `userId` should be rendered in --
 * an email, or a Web Push body, which is composed on the server for the same
 * reason and therefore has the same question to answer.
 *
 * The copy must match the recipient's own language, not the request locale of
 * whoever triggered the send (an admin provisioning an account, a scheduler, or
 * an attacker tripping the failed-login lockout). Precedence:
 *
 * 1. the recipient's stored, concrete `user_preferences.language`;
 * 2. otherwise -- when the user has no row, no preference, or the "browser"
 *    follow-the-browser sentinel -- the current request/browser locale;
 * 3. otherwise the default locale (what {@link currentRequestLocale} returns
 *    outside an HTTP context, e.g. cron jobs and fire-and-forget sends).
 *
 * The "browser" sentinel and any unsupported value are treated as "no concrete
 * stored preference" so they fall through rather than being handed to the
 * translator verbatim.
 *
 * @param preferencesRepo repository for {@link UserPreference}
 * @param userId the recipient's user id, or null/undefined when the recipient
 *   is not a known Monize user (e.g. an emergency contact without an account)
 */
export async function resolveUserEmailLocale(
  preferencesRepo: Repository<UserPreference>,
  userId: string | null | undefined,
): Promise<string> {
  return (await resolveUserEmailFormats(preferencesRepo, userId)).lang;
}

/**
 * Both rendering preferences a message addressed to `userId` needs, from the
 * one row that holds them.
 *
 * A figure is localized by its OWN preference: `user_preferences.number_format`
 * decides separators, grouping and currency placement independently of
 * `language`, so a caller that resolved only the language and formatted from it
 * would put `zl18,812.71` inside Polish copy for the reader who set
 * `numberFormat` and left the UI in English (issue #1316).
 *
 * Deliberately one query answering both, and {@link resolveUserEmailLocale}
 * delegating to it: two readers of the same row are two chances for the language
 * precedence above to be spelled differently.
 *
 * `numberFormat` is returned as stored -- `null` when there is no row, and the
 * `"browser"` sentinel verbatim -- because `numberFormatterFor` is what knows
 * that both of those mean "fall back to the language".
 */
export async function resolveUserEmailFormats(
  preferencesRepo: Repository<UserPreference>,
  userId: string | null | undefined,
): Promise<{ lang: string; numberFormat: string | null }> {
  if (userId) {
    const prefs = await preferencesRepo.findOne({ where: { userId } });
    const stored = prefs?.language;
    const numberFormat = prefs?.numberFormat ?? null;
    if (stored && stored !== "browser" && isSupportedLocale(stored)) {
      return { lang: stored, numberFormat };
    }
    return { lang: currentRequestLocale(), numberFormat };
  }
  return { lang: currentRequestLocale(), numberFormat: null };
}
