/**
 * The outbound market-data providers whose availability is tracked.
 *
 * The id is what goes in `provider_health.provider` and must stay stable -- it
 * is the primary key of the durable notification state, so renaming one starts
 * a fresh outage episode and could re-send an alert. The label is what an
 * operator reads in an email.
 */
export const TRACKED_PROVIDERS = {
  yahoo_finance: "Yahoo Finance",
  msn_finance: "MSN Finance",
} as const;

export type TrackedProviderId = keyof typeof TRACKED_PROVIDERS;

/** The human name for a provider id, or the id itself for an unknown one. */
export function providerLabel(provider: string): string {
  return (
    (TRACKED_PROVIDERS as Record<string, string | undefined>)[provider] ??
    provider
  );
}
