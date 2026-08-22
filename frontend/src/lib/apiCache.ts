type CacheEntry<T> = {
  data: T;
  timestamp: number;
  ttl: number;
};

const cache = new Map<string, CacheEntry<unknown>>();
const DEFAULT_TTL = 30_000; // 30 seconds

// An in-flight deduplicated fetch carries the generation its key held when it
// started. Invalidation advances a key's generation, which does two things at
// once: it drops the entry from `inflight` so a later caller starts a fresh
// request instead of joining the pre-invalidation one, and it leaves the old
// promise holding a stale generation so its `.then` refuses to write the result
// back to `cache`. Without this, a read that began before a mutation could be
// re-served after it -- and even a read nobody joined would resurrect the
// pre-mutation payload when it eventually resolved (issue #1167 close-out).
type InflightEntry = { promise: Promise<unknown>; generation: number };
const inflight = new Map<string, InflightEntry>();

// Current generation per key. Absent means 0. Monotonic within a key: only ever
// bumped, so a promise that captured an earlier value can always tell it has
// been superseded. Retained across a resolve (and across clearAllCache) so a
// still-pending old fetch cannot find its own stale generation "current" again.
const keyGeneration = new Map<string, number>();

function currentGeneration(key: string): number {
  return keyGeneration.get(key) ?? 0;
}

function bumpGeneration(key: string): void {
  keyGeneration.set(key, currentGeneration(key) + 1);
}

export function getCached<T>(key: string): T | undefined {
  const entry = cache.get(key);
  if (!entry) return undefined;
  if (Date.now() - entry.timestamp > entry.ttl) {
    cache.delete(key);
    return undefined;
  }
  return entry.data as T;
}

export function setCache<T>(key: string, data: T, ttl: number = DEFAULT_TTL): void {
  cache.set(key, { data, timestamp: Date.now(), ttl });
}

export function invalidateCache(keyPrefix: string): void {
  for (const key of cache.keys()) {
    if (key.startsWith(keyPrefix)) {
      cache.delete(key);
    }
  }
  // Make matching in-flight fetches obsolete too: bump their generation (so
  // their eventual result is not written to cache) and drop them from
  // deduplication (so the next caller starts a fresh request). Deleting the
  // completed cache entry alone is not enough -- a request already on the wire
  // when the mutation lands would otherwise repopulate `cache` with pre-mutation
  // data, or be handed straight to a later caller.
  for (const key of inflight.keys()) {
    if (key.startsWith(keyPrefix)) {
      bumpGeneration(key);
      inflight.delete(key);
    }
  }
}

export function clearAllCache(): void {
  cache.clear();
  // Same reasoning as invalidateCache, for every key at once: a fetch already
  // in flight when the cache is cleared must not resurrect its result
  // afterward, so advance each in-flight key's generation before dropping it.
  for (const key of inflight.keys()) {
    bumpGeneration(key);
  }
  inflight.clear();
}

/**
 * Drop every cached view of a balance. Call this from any write that moves
 * money -- posting a scheduled transaction, editing a split, an investment
 * trade, an import -- not just the ones that go through `transactionsApi`.
 *
 * `accountsApi.getAll` caches for two minutes and the backend computes the
 * balance live from transactions, so a write that skips this leaves the
 * Accounts page showing the pre-write number until the entry ages out or the
 * browser reloads. Navigating back to the page does not help: the page
 * refetches on mount and the refetch is served from this cache.
 *
 * The prefixes go together because an account balance, a portfolio value and a
 * budget's progress are three views of the same rows: a trade moves the
 * INVESTMENT_CASH balance, a split transfer moves an account the parent
 * transaction never named, and any categorised amount moves the budget it falls
 * in. `budgets:dashboard` caches for 30 seconds and `budgets:cat-status:*` for
 * 60, so leaving them behind means the write succeeds and the progress bar
 * beside it still shows the pre-write remaining amount -- which is the number a
 * user makes the next spending decision from.
 *
 * Anything derived from transaction rows belongs on this list. Adding a new
 * cached family that reads them means adding its prefix here in the same
 * change; `balance-cache.guard.test.ts` holds the call sites, and
 * `apiCache.test.ts` holds the prefix set.
 */
export function invalidateBalanceCaches(): void {
  invalidateCache('accounts:');
  invalidateCache('investments:');
  invalidateCache('budgets:');
}

/**
 * Drop the scheduled-transaction read model when an upstream FX input changes.
 *
 * The `scheduled:all` payload now carries server-derived, current-settlement-pair
 * FX fields (`investmentForecastExchangeRate` / `investmentForecastAmount`, issue
 * #1167). Those are resolved from `exchange_rates` snapshots and from the security's
 * and settlement account's currencies -- none of which a transaction write touches,
 * so this is deliberately NOT part of `invalidateBalanceCaches`. Call it after any
 * operation that can change one side of a scheduled investment's settlement pair
 * or the rate it resolves at: a successful exchange-rate refresh, an account edit
 * (funding/linked-cash/brokerage currency), or a security edit (currency). Call it
 * AFTER the mutation succeeds -- the generation-aware primitive then also obsoletes
 * any scheduled read already in flight, so a request that started before the change
 * cannot repopulate the cache with the pre-change value.
 */
export function invalidateScheduledFxReadModel(): void {
  invalidateCache('scheduled:');
}

// Cache + in-flight deduplication. When several callers request the same key
// before the first response arrives, they all await the same promise instead
// of triggering parallel network requests. Successful responses are cached
// for `ttl` ms; failures are not cached and propagate to every awaiter.
export function dedupe<T>(
  key: string,
  fetcher: () => Promise<T>,
  ttl: number = DEFAULT_TTL,
): Promise<T> {
  const cached = getCached<T>(key);
  if (cached !== undefined) return Promise.resolve(cached);

  const existing = inflight.get(key);
  if (existing) return existing.promise as Promise<T>;

  const generation = currentGeneration(key);
  const promise = fetcher()
    .then((data) => {
      // Only cache the result if this fetch is still the current one for its
      // key. An invalidation (prefix or clearAll) that raced this request
      // advanced the generation, and writing the pre-invalidation payload now
      // would resurrect exactly the stale data the invalidation removed.
      if (currentGeneration(key) === generation) {
        setCache(key, data, ttl);
      }
      return data;
    })
    .finally(() => {
      // Delete our own tracking entry only -- never a newer request's. After an
      // invalidation drops this key and a fresh fetch re-registers it, this old
      // promise's `finally` must not evict the replacement.
      if (inflight.get(key)?.promise === promise) {
        inflight.delete(key);
      }
    });

  inflight.set(key, { promise, generation });
  return promise;
}
