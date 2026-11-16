/**
 * How long one Ollama call may run before its own abort fires. CPU-only
 * inference of a long prompt takes minutes, so the provider waits this long
 * (`ollama.provider.ts`).
 */
export const OLLAMA_CALL_TIMEOUT_MS = 20 * 60 * 1000;

/**
 * The slowest single provider call any caller can start: the largest of the
 * providers' own aborts (Ollama's; Anthropic aborts at two minutes).
 *
 * A job lease guarding a provider call must outlast it, or the call runs on
 * after the lease expired and a second holder starts the same work beside it
 * (A26-L13, INV-CRON-001). A lease TTL is derived from this, never chosen on
 * its own.
 */
export const PROVIDER_CALL_BUDGET_MS = OLLAMA_CALL_TIMEOUT_MS;
