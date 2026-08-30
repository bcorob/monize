/**
 * Thrown instead of making a request the circuit breaker has refused.
 *
 * A distinct type because it means something different from every other error a
 * provider call can raise: nothing was attempted, so it is not evidence about
 * the provider beyond what the breaker already recorded and logged once. Call
 * sites must not log it per occurrence -- that was the flood (issue #1265) --
 * and `ProviderHealthService.logFailure` counts it as suppressed rather than
 * printing it.
 */
export class ProviderUnavailableError extends Error {
  constructor(
    readonly provider: string,
    readonly retryAfterMs: number,
    readonly lastFailureReason: string | null,
  ) {
    super(
      `${provider} is marked unavailable; not retried for another ` +
        `${Math.ceil(retryAfterMs / 1000)}s` +
        (lastFailureReason ? ` (last failure: ${lastFailureReason})` : ""),
    );
    this.name = "ProviderUnavailableError";
  }
}

/** Narrowing helper, so call sites do not import the class just to test it. */
export function isProviderUnavailable(
  error: unknown,
): error is ProviderUnavailableError {
  return error instanceof ProviderUnavailableError;
}
