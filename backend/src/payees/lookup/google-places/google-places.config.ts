import { Logger } from "@nestjs/common";
import { resolvePositiveInt } from "../../../common/env-number.util";
import { GOOGLE_PLACES_CAP } from "./google-places-cap";

/**
 * The operator's own Google Places key, and the cap that applies to it.
 *
 * This is the deployment's resource, so it is configured the way every other
 * deployment resource is -- environment variables, editable nowhere in the UI
 * -- and it follows the rule in `docs/backend/modules-and-runtime.md`: an environment variable
 * configures the deployment's own resource, never somebody else's. Where the
 * operator has set a key, every user's lookups spend it and the operator's cap
 * is the only one that applies; a user's own key and cap live on
 * `payee_lookup_settings` and are never sized from here.
 *
 * Declared as one table of `{ envVar, default, description }` so the set
 * cannot grow a knob with no name, default or documentation --
 * `google-places.config.spec.ts` checks it against `.env.example` in both
 * directions.
 */
export interface GooglePlacesEnvSpec {
  readonly envVar: string;
  readonly default?: number;
  readonly description: string;
}

export const GOOGLE_PLACES_ENV_SPECS = {
  apiKey: {
    envVar: "GOOGLE_PLACES_API_KEY",
    description:
      "operator-wide Google Places API key for payee contact lookups (unset = each user may configure their own)",
  },
  monthlyCap: {
    envVar: "GOOGLE_PLACES_MONTHLY_CAP",
    default: GOOGLE_PLACES_CAP.default,
    description:
      "requests per calendar month against the operator's key before lookups fall back to AI",
  },
} as const satisfies Record<string, GooglePlacesEnvSpec>;

/** What the deployment configured, or `null` when it configured no key. */
export interface OperatorGooglePlaces {
  apiKey: string;
  monthlyCap: number;
}

export interface EnvReader {
  get<T = string>(key: string): T | undefined;
}

/**
 * Read the operator's configuration.
 *
 * The key is the whole switch: with no key there is nothing for a cap to
 * limit, so the function answers `null` and each user's own row decides. An
 * invalid cap is logged rather than silently accepted, which is the whole
 * reason for `resolvePositiveInt` -- an operator who typed `GOOGLE_PLACES_MONTHLY_CAP=1,000`
 * should find out from the log, not from a bill.
 */
export function resolveOperatorGooglePlaces(
  reader: EnvReader | undefined,
  logger?: Logger,
): OperatorGooglePlaces | null {
  const rawKey = reader?.get<string>(GOOGLE_PLACES_ENV_SPECS.apiKey.envVar);
  const apiKey = typeof rawKey === "string" ? rawKey.trim() : "";
  if (!apiKey) return null;

  const spec = GOOGLE_PLACES_ENV_SPECS.monthlyCap;
  const resolved = resolvePositiveInt(reader?.get(spec.envVar), spec.default);
  if (resolved.invalid) {
    logger?.warn(
      `${spec.envVar} must be a positive integer; using ${spec.default} (${spec.description}).`,
    );
  }
  return { apiKey, monthlyCap: resolved.value };
}
