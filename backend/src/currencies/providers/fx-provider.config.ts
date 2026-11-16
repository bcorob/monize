import { FX_PROVIDER_NAMES, FxProviderName } from "./fx-provider.interface";

/**
 * The providers asked when `FX_PROVIDERS` is unset or empty, in order.
 * Frankfurter (ECB reference rates) first, Yahoo second
 * (`docs/specs/exchange-rate-providers.md`, decision 2). Set
 * `FX_PROVIDERS=yahoo,frankfurter` to restore the previous order.
 */
export const DEFAULT_FX_PROVIDERS: readonly FxProviderName[] = [
  "frankfurter",
  "yahoo",
];

/**
 * `FX_PROVIDERS` named something that is not a provider.
 *
 * Thrown from the module factory, so a typo is a failed start with one line
 * naming the bad token and the valid names, not a deployment quietly calling
 * a provider the operator meant to exclude. A numeric knob falls back to its
 * default when it cannot be read (`resolvePositiveInt`); this one does not,
 * because here the default may be the very provider being turned off
 * (decision 11).
 */
export class FxProviderConfigError extends Error {
  constructor(
    readonly token: string,
    readonly validNames: readonly string[],
  ) {
    super(
      `FX_PROVIDERS names an unknown exchange rate provider "${token}"; ` +
        `the valid names are ${validNames.join(", ")}`,
    );
    this.name = "FxProviderConfigError";
  }
}

function isFxProviderName(token: string): token is FxProviderName {
  return (FX_PROVIDER_NAMES as readonly string[]).includes(token);
}

/**
 * The ordered provider names a raw `FX_PROVIDERS` value asks for.
 *
 * Split on commas, each token trimmed and lower-cased, empty tokens dropped,
 * a repeated name kept at its first position. Unset, empty or whitespace is
 * the default list. Any other token that is not in `FX_PROVIDER_NAMES` throws
 * `FxProviderConfigError`; nothing is silently skipped, because a list with
 * one name missing is a different deployment from the one the operator wrote.
 */
export function resolveFxProviders(
  raw: string | null | undefined,
): FxProviderName[] {
  const tokens = (raw ?? "")
    .split(",")
    .map((token) => token.trim().toLowerCase())
    .filter((token) => token.length > 0);
  if (tokens.length === 0) return [...DEFAULT_FX_PROVIDERS];

  const names: FxProviderName[] = [];
  for (const token of tokens) {
    if (!isFxProviderName(token)) {
      throw new FxProviderConfigError(token, FX_PROVIDER_NAMES);
    }
    if (!names.includes(token)) names.push(token);
  }
  return names;
}
