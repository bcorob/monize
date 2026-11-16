import { isGbxCurrency } from "../../common/gbx-currency.util";

/**
 * Whether a provider's answer may be stored against a security, decided from
 * the currency the provider says the instrument trades in.
 *
 * A price is a number in a currency, and `security_prices` stores only the
 * number: the currency it is in is whatever `securities.currency_code` says.
 * So a provider that answered about a *different listing* -- the same ticker on
 * another exchange, in another currency -- writes numbers that are silently
 * wrong by the exchange rate, on every row, with nothing in the stored series
 * to show it. That is what this decides, once, for every acceptance path.
 */
export type ProviderCurrencyVerdict =
  /** Provider and security agree on the currency; the payload may be stored. */
  | { accepted: true; verified: true; currency: string }
  /**
   * Nobody contradicted anybody: either the provider reports no currency
   * (MSN's chart series routinely does not) or the security carries none. The
   * payload is stored, because refusing every silent provider would leave those
   * securities with no prices at all, but the caller logs that it is unverified.
   */
  | {
      accepted: true;
      verified: false;
      reason: "provider-silent" | "security-unset";
    }
  /** The provider named a different currency: refuse before writing. */
  | { accepted: false; configured: string; reported: string };

/**
 * The comparable form of a currency code: trimmed, upper-cased, and with the
 * LSE's pence quote unit mapped to pounds.
 *
 * GBX/GBp is a unit of GBP, not another currency, and both providers already
 * divide their pence *prices* by 100 before returning them (`convertGbxToGbp`),
 * so by the time an answer reaches an acceptance point the numbers are pounds.
 * Mapping the code here is therefore a comparison, not a second conversion:
 * the function is idempotent, and "GBP" in gives "GBP" out.
 */
export function normalizeQuoteCurrency(
  code: string | null | undefined,
): string | null {
  if (!code) return null;
  const trimmed = code.trim();
  if (!trimmed) return null;
  return isGbxCurrency(trimmed) ? "GBP" : trimmed.toUpperCase();
}

/**
 * Compare the currency a provider reported with the one the security is
 * configured in, after normalizing both the same way.
 *
 * Both arguments are raw codes as stored or as reported; normalization happens
 * here so no caller can apply it twice or forget it.
 */
export function verifyProviderCurrency(
  configuredCode: string | null | undefined,
  reportedCode: string | null | undefined,
): ProviderCurrencyVerdict {
  const configured = normalizeQuoteCurrency(configuredCode);
  const reported = normalizeQuoteCurrency(reportedCode);
  if (!configured)
    return { accepted: true, verified: false, reason: "security-unset" };
  if (!reported)
    return { accepted: true, verified: false, reason: "provider-silent" };
  if (configured === reported) {
    return { accepted: true, verified: true, currency: configured };
  }
  return { accepted: false, configured, reported };
}
