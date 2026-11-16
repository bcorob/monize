import {
  SHARE_CACHE_NAME,
  SHARE_KEY_PREFIX,
  SHARE_NAME_HEADER,
  isExpiredBundle,
  isShareBundleId,
  shareBundleIdFromIndexKey,
  shareIndexKey,
  type SharedBundleIndex,
  type SharedFileEntry,
} from './share-target';

/**
 * The window's half of the share stash: the ONE reader of the cache the service
 * worker writes when the OS shares files into the installed PWA. Nothing else
 * names `SHARE_CACHE_NAME` or builds a stash key -- a second reader is how the
 * key shape and the worker's writer drift apart.
 *
 * **A bundle belongs to the first authenticated reader that sees it.** The worker
 * cannot know whose share it is -- a share can arrive with nobody signed in,
 * which is the whole point of the logged-out resume -- so ownership is settled
 * on the app side: the first authenticated observation stamps `ownerUserId` on
 * the index, and from then on the bundle is invisible to every other account.
 * Two people share a browser profile, and a session that simply expired never
 * ran `logout`, so clearing on sign-out alone left one account's receipt on
 * offer to the next (the same reasoning as the push-registration marker's
 * owner). First-come-first-served is the only rule available here, and it closes
 * the case that matters: a share the sharer was told about is already theirs.
 *
 * Every function here feature-detects the Cache API and treats its absence as an
 * empty inbox rather than an error: a browser without it (or a private window
 * that refuses storage) simply has nothing shared, and the review screen says
 * so. None of these reject; a caller on a page-mount path or in `logout` must
 * not have to guard them.
 */

/** True when this browser can hold a share stash at all. */
export function isShareInboxSupported(): boolean {
  try {
    return typeof caches !== 'undefined' && typeof caches.open === 'function';
  } catch {
    // Some browsers throw on the property access itself when storage is blocked.
    return false;
  }
}

async function openShareCache(): Promise<Cache | null> {
  if (!isShareInboxSupported()) return null;
  try {
    return await caches.open(SHARE_CACHE_NAME);
  } catch {
    return null;
  }
}

function isShareEntry(entry: unknown): entry is SharedFileEntry {
  if (!entry || typeof entry !== 'object') return false;
  const candidate = entry as Record<string, unknown>;
  return (
    typeof candidate.name === 'string' &&
    typeof candidate.type === 'string' &&
    typeof candidate.size === 'number'
  );
}

/** Read and shape-check one index. Anything malformed reads as absent. */
function parseIndex(value: unknown): SharedBundleIndex | null {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as Record<string, unknown>;
  if (!isShareBundleId(candidate.id)) return null;
  if (typeof candidate.createdAt !== 'number') return null;
  if (!Array.isArray(candidate.files)) return null;
  const files = candidate.files.filter(isShareEntry);
  if (files.length !== candidate.files.length) return null;
  // An owner that is not a string is no owner: an unreadable stamp must not be
  // mistaken for somebody's claim, nor silently grant the bundle to everyone.
  const ownerUserId =
    typeof candidate.ownerUserId === 'string' && candidate.ownerUserId.length > 0
      ? candidate.ownerUserId
      : undefined;
  return { id: candidate.id, createdAt: candidate.createdAt, files, ownerUserId };
}

/** True when this reader may see the bundle: theirs, or nobody's yet. */
function isVisibleTo(index: SharedBundleIndex, viewerUserId: string): boolean {
  return index.ownerUserId === undefined || index.ownerUserId === viewerUserId;
}

/**
 * Stamp an unclaimed bundle with its reader, so no other account can see it.
 *
 * Rewrites only the index, never the bytes. A concurrent claim from another tab
 * of the same account writes the same owner, and one from another account cannot
 * happen: it would not have seen this bundle to claim it.
 */
async function claimIndex(
  cache: Cache,
  index: SharedBundleIndex,
  viewerUserId: string,
): Promise<SharedBundleIndex> {
  if (index.ownerUserId !== undefined) return index;
  const claimed: SharedBundleIndex = { ...index, ownerUserId: viewerUserId };
  try {
    await cache.put(
      shareIndexKey(index.id),
      new Response(JSON.stringify(claimed), {
        headers: { 'Content-Type': 'application/json' },
      }),
    );
  } catch {
    // A stash that cannot be written is still readable by this reader; the next
    // observation tries again. Returning the claimed shape keeps this call
    // consistent with what it reports.
  }
  return claimed;
}

async function readIndex(
  cache: Cache,
  id: string,
): Promise<SharedBundleIndex | null> {
  try {
    const response = await cache.match(shareIndexKey(id));
    if (!response) return null;
    return parseIndex(await response.json());
  } catch {
    return null;
  }
}

/** Every stash key belonging to one bundle, index included. */
async function keysForBundle(cache: Cache, id: string): Promise<Request[]> {
  const prefix = `${SHARE_KEY_PREFIX}${id}/`;
  try {
    const keys = await cache.keys();
    return keys.filter((request) => {
      try {
        return new URL(request.url).pathname.startsWith(prefix);
      } catch {
        return false;
      }
    });
  } catch {
    return [];
  }
}

/**
 * The indexes of every bundle still in the stash, newest first. Expired bundles
 * are excluded but not deleted -- `purgeExpiredSharedBundles` does that, so a
 * read stays a read.
 */
export async function listSharedBundles(
  viewerUserId: string,
  now: number = Date.now(),
): Promise<SharedBundleIndex[]> {
  const cache = await openShareCache();
  if (!cache || !viewerUserId) return [];

  let keys: readonly Request[];
  try {
    keys = await cache.keys();
  } catch {
    return [];
  }

  const ids = keys
    .map((request) => shareBundleIdFromIndexKey(request.url))
    .filter((id): id is string => id !== null);

  const indexes = await Promise.all(ids.map((id) => readIndex(cache, id)));
  const live = indexes
    .filter((index): index is SharedBundleIndex => index !== null)
    .filter((index) => !isExpiredBundle(index, now))
    .filter((index) => isVisibleTo(index, viewerUserId));

  // Listing is an authenticated observation, so it claims: a share the sharer
  // was merely NOTIFIED about is already theirs, which is the case that would
  // otherwise still be readable by whoever signs in next.
  const claimed = await Promise.all(
    live.map((index) => claimIndex(cache, index, viewerUserId)),
  );
  return claimed.sort((a, b) => b.createdAt - a.createdAt);
}

/** One entry, paired with the bytes behind it when they are still there. */
export interface SharedBundleItem {
  entry: SharedFileEntry;
  /** The file, or null when the entry was refused or its bytes are gone. */
  file: File | null;
  /**
   * The worker accepted this file but its bytes are no longer in the cache
   * (storage pressure, a partial eviction). Distinct from a refusal: the user
   * is told it is unavailable, not why it was rejected -- and it is never
   * silently dropped from a list that then looks complete.
   */
  missing: boolean;
}

export interface SharedBundle {
  index: SharedBundleIndex;
  /** Every entry the share carried, in order, accepted or not. */
  items: SharedBundleItem[];
  /** Just the files that are actually present, in the same order. */
  files: File[];
  /** True once the bundle is older than the stash lifetime. */
  expired: boolean;
}

async function readEntryFile(
  cache: Cache,
  entry: SharedFileEntry,
): Promise<File | null> {
  if (!entry.key) return null;
  try {
    const response = await cache.match(entry.key);
    if (!response) return null;
    // Bytes, not a Blob: `new File([blob], ...)` depends on the Blob and the
    // File constructor coming from the same realm, which is exactly the kind of
    // assumption that holds in a browser and silently stringifies the blob
    // elsewhere. An ArrayBuffer is a plain value and carries no realm.
    const bytes = await response.arrayBuffer();
    // The index is authoritative for the name and type: it is the only record
    // that also covers refused entries, and the header beside the bytes exists
    // so a stored Response is self-describing, not as a second source.
    const name =
      entry.name ||
      decodeURIComponent(response.headers.get(SHARE_NAME_HEADER) ?? '') ||
      'shared-file';
    return new File([bytes], name, {
      type:
        entry.type ||
        response.headers.get('Content-Type') ||
        'application/octet-stream',
    });
  } catch {
    return null;
  }
}

/**
 * One bundle, with its bytes. `null` when the id names nothing in the stash --
 * which the review screen reports as "expired or already used", never as an
 * empty share.
 */
export async function readSharedBundle(
  id: string,
  viewerUserId: string,
  now: number = Date.now(),
): Promise<SharedBundle | null> {
  if (!isShareBundleId(id) || !viewerUserId) return null;
  const cache = await openShareCache();
  if (!cache) return null;

  const found = await readIndex(cache, id);
  if (!found) return null;
  // Another account's share is not this reader's to see, and reads as absent
  // rather than as a refusal: the id came off a URL, and "whose is it" is not a
  // question this screen should answer to whoever pasted one.
  if (!isVisibleTo(found, viewerUserId)) return null;
  const index = isExpiredBundle(found, now)
    ? found
    : await claimIndex(cache, found, viewerUserId);

  const items: SharedBundleItem[] = [];
  for (const entry of index.files) {
    const file = await readEntryFile(cache, entry);
    items.push({
      entry,
      file,
      missing: Boolean(entry.key) && file === null,
    });
  }

  return {
    index,
    items,
    files: items
      .map((item) => item.file)
      .filter((file): file is File => file !== null),
    expired: isExpiredBundle(index, now),
  };
}

/** Remove one bundle: its index and every file it stored. */
export async function discardSharedBundle(id: string): Promise<void> {
  if (!isShareBundleId(id)) return;
  const cache = await openShareCache();
  if (!cache) return;
  const keys = await keysForBundle(cache, id);
  await Promise.all(
    keys.map((request) => cache.delete(request).catch(() => false)),
  );
}

/**
 * Drop everything past the stash lifetime, and any file bytes whose index is
 * gone. The worker purges on activate and on each share; this is the same sweep
 * from the app, so a bundle the user never opened still expires while the
 * worker sits idle.
 */
export async function purgeExpiredSharedBundles(
  now: number = Date.now(),
): Promise<void> {
  const cache = await openShareCache();
  if (!cache) return;

  let keys: readonly Request[];
  try {
    keys = await cache.keys();
  } catch {
    return;
  }

  // Group every key by the bundle it belongs to, so an orphaned file (bytes
  // whose index expired or never committed) is swept with its siblings rather
  // than lingering unreferenced.
  const byBundle = new Map<string, Request[]>();
  for (const request of keys) {
    let pathname: string;
    try {
      pathname = new URL(request.url).pathname;
    } catch {
      continue;
    }
    if (!pathname.startsWith(SHARE_KEY_PREFIX)) continue;
    const id = pathname.slice(SHARE_KEY_PREFIX.length).split('/')[0];
    if (!isShareBundleId(id)) continue;
    const existing = byBundle.get(id);
    if (existing) existing.push(request);
    else byBundle.set(id, [request]);
  }

  for (const [id, requests] of byBundle) {
    const index = await readIndex(cache, id);
    if (index && !isExpiredBundle(index, now)) continue;
    await Promise.all(
      requests.map((request) => cache.delete(request).catch(() => false)),
    );
  }
}

/**
 * Drop the whole stash. Called from `logout` beside `clearAllCache()`: a share
 * is one account's document, and the next account to sign in on this device
 * must not find it waiting.
 */
export async function clearShareInbox(): Promise<void> {
  if (!isShareInboxSupported()) return;
  try {
    await caches.delete(SHARE_CACHE_NAME);
  } catch {
    // Nothing to clear, or storage refused -- either way there is no inbox.
  }
}
