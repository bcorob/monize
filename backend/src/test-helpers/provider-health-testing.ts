import { DataSource } from "typeorm";
import { ProviderHealthService } from "../provider-health/provider-health.service";

/**
 * A real `ProviderHealthService` for unit tests of its callers.
 *
 * The breaker is real -- a double would let a caller's "does it stop calling
 * out" test pass without the behaviour existing -- while the durable write has
 * nowhere to go. That is safe by construction rather than by mocking: the
 * service's persistence is fire-and-forget and swallows its own failures,
 * because availability bookkeeping must never turn a provider outage into a
 * failed request. Specs that care about the write build the scoped-db mocks and
 * construct the service themselves (`provider-health.service.spec.ts`).
 *
 * @param now optional clock, for a spec that needs to move the breaker's
 *   windows without waiting them out.
 */
export function createTestProviderHealth(
  now: () => number = Date.now,
): ProviderHealthService {
  return new ProviderHealthService(undefined as unknown as DataSource, now);
}
