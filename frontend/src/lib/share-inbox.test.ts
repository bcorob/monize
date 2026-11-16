import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  SHARE_CACHE_NAME,
  SHARE_NAME_HEADER,
  SHARE_STASH_TTL_MS,
  shareFileKey,
  shareIndexKey,
  type SharedBundleIndex,
} from './share-target';
import {
  clearShareInbox,
  discardSharedBundle,
  isShareInboxSupported,
  listSharedBundles,
  purgeExpiredSharedBundles,
  readSharedBundle,
} from './share-inbox';

const ORIGIN = 'https://monize.test';

/**
 * An in-memory stand-in for the Cache API. The real thing is not in jsdom, and
 * these tests are about what this module does with what the worker left behind,
 * so the store is a plain map keyed by absolute URL -- the same normalisation
 * the browser applies.
 */
function createCacheStorage() {
  const caches_ = new Map<string, Map<string, Response>>();

  const absolute = (key: string) => new URL(key, ORIGIN).toString();

  const makeCache = (store: Map<string, Response>) => ({
    async keys() {
      return [...store.keys()].map((url) => new Request(url));
    },
    async match(key: string | Request) {
      const url = absolute(typeof key === 'string' ? key : key.url);
      const hit = store.get(url);
      return hit ? hit.clone() : undefined;
    },
    async put(key: string | Request, response: Response) {
      store.set(absolute(typeof key === 'string' ? key : key.url), response);
    },
    async delete(key: string | Request) {
      return store.delete(absolute(typeof key === 'string' ? key : key.url));
    },
  });

  return {
    storage: {
      async open(name: string) {
        let store = caches_.get(name);
        if (!store) {
          store = new Map();
          caches_.set(name, store);
        }
        return makeCache(store);
      },
      async delete(name: string) {
        return caches_.delete(name);
      },
      async keys() {
        return [...caches_.keys()];
      },
    },
    raw: caches_,
    storeFor(name: string) {
      return caches_.get(name);
    },
  };
}

const NOW = 1_700_000_000_000;

/** The reader every case below is written from the point of view of. */
const VIEWER = 'user-1';
/** Somebody else on the same browser profile. */
const OTHER = 'user-2';

type SeedFile = {
  name: string;
  type: string;
  size?: number;
  body?: string;
  reason?: string;
  /** Write the index entry but not the bytes, as an eviction would leave it. */
  evicted?: boolean;
};

async function seedBundle(
  cacheStorage: ReturnType<typeof createCacheStorage>,
  id: string,
  files: SeedFile[],
  createdAt = NOW,
  /** Whose share it already is. Omitted means the worker's unclaimed shape. */
  ownerUserId?: string,
) {
  const cache = await cacheStorage.storage.open(SHARE_CACHE_NAME);
  const entries = files.map((file, position) => {
    const body = file.body ?? 'x';
    const base = {
      name: file.name,
      type: file.type,
      size: file.size ?? body.length,
      kind: file.reason ? null : 'attachment',
    };
    return file.reason
      ? { ...base, reason: file.reason }
      : { ...base, key: shareFileKey(id, position) };
  });

  const index: SharedBundleIndex = {
    id,
    createdAt,
    files: entries as SharedBundleIndex['files'],
    ...(ownerUserId ? { ownerUserId } : {}),
  };
  await cache.put(shareIndexKey(id), new Response(JSON.stringify(index)));

  for (const [position, file] of files.entries()) {
    if (file.reason || file.evicted) continue;
    await cache.put(
      shareFileKey(id, position),
      new Response(file.body ?? 'x', {
        headers: {
          'Content-Type': file.type || 'application/octet-stream',
          [SHARE_NAME_HEADER]: encodeURIComponent(file.name),
        },
      }),
    );
  }
  return index;
}

describe('share inbox', () => {
  let cacheStorage: ReturnType<typeof createCacheStorage>;

  beforeEach(() => {
    cacheStorage = createCacheStorage();
    vi.stubGlobal('caches', cacheStorage.storage);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('rebuilds a File with the index name and type', async () => {
    await seedBundle(cacheStorage, 'bundle-1', [
      { name: 'receipt.png', type: 'image/png', body: 'PNGDATA' },
    ]);

    const bundle = await readSharedBundle('bundle-1', VIEWER, NOW);

    expect(bundle).not.toBeNull();
    expect(bundle!.files).toHaveLength(1);
    expect(bundle!.files[0].name).toBe('receipt.png');
    expect(bundle!.files[0].type).toBe('image/png');
    expect(await bundle!.files[0].text()).toBe('PNGDATA');
    expect(bundle!.expired).toBe(false);
  });

  it('keeps a refused entry in the list, with its reason and no file', async () => {
    await seedBundle(cacheStorage, 'bundle-2', [
      { name: 'ok.png', type: 'image/png' },
      { name: 'huge.pdf', type: 'application/pdf', reason: 'tooLarge' },
    ]);

    const bundle = await readSharedBundle('bundle-2', VIEWER, NOW);

    expect(bundle!.items).toHaveLength(2);
    expect(bundle!.items[1].entry.reason).toBe('tooLarge');
    expect(bundle!.items[1].file).toBeNull();
    expect(bundle!.items[1].missing).toBe(false);
    expect(bundle!.files).toHaveLength(1);
  });

  // A lookup that failed is not an empty result: an accepted entry whose bytes
  // are gone is reported as missing rather than quietly dropped from a list
  // that would then look complete.
  it('marks an accepted entry whose bytes are gone as missing, not refused', async () => {
    await seedBundle(cacheStorage, 'bundle-3', [
      { name: 'gone.png', type: 'image/png', evicted: true },
    ]);

    const bundle = await readSharedBundle('bundle-3', VIEWER, NOW);

    expect(bundle!.items[0].missing).toBe(true);
    expect(bundle!.items[0].entry.reason).toBeUndefined();
    expect(bundle!.files).toHaveLength(0);
  });

  it('reports an unknown or malformed bundle as absent', async () => {
    expect(await readSharedBundle('nothing-here', VIEWER, NOW)).toBeNull();
    expect(await readSharedBundle('../escape', VIEWER, NOW)).toBeNull();

    const cache = await cacheStorage.storage.open(SHARE_CACHE_NAME);
    await cache.put(shareIndexKey('bad'), new Response('not json'));
    expect(await readSharedBundle('bad', VIEWER, NOW)).toBeNull();

    await cache.put(shareIndexKey('shapeless'), new Response('{"id":"shapeless"}'));
    expect(await readSharedBundle('shapeless', VIEWER, NOW)).toBeNull();
  });

  it('flags an expired bundle rather than hiding it from a direct read', async () => {
    await seedBundle(
      cacheStorage,
      'old',
      [{ name: 'a.png', type: 'image/png' }],
      NOW - SHARE_STASH_TTL_MS,
    );

    const bundle = await readSharedBundle('old', VIEWER, NOW);

    expect(bundle).not.toBeNull();
    expect(bundle!.expired).toBe(true);
  });

  it('lists live bundles newest first and omits expired ones', async () => {
    await seedBundle(cacheStorage, 'older', [{ name: 'a.png', type: 'image/png' }], NOW - 1000);
    await seedBundle(cacheStorage, 'newer', [{ name: 'b.png', type: 'image/png' }], NOW - 10);
    await seedBundle(
      cacheStorage,
      'stale',
      [{ name: 'c.png', type: 'image/png' }],
      NOW - SHARE_STASH_TTL_MS - 1,
    );

    const listed = await listSharedBundles(VIEWER, NOW);

    expect(listed.map((index) => index.id)).toEqual(['newer', 'older']);
  });

  it('discards a bundle with all of its files', async () => {
    await seedBundle(cacheStorage, 'doomed', [
      { name: 'a.png', type: 'image/png' },
      { name: 'b.png', type: 'image/png' },
    ]);
    await seedBundle(cacheStorage, 'kept', [{ name: 'c.png', type: 'image/png' }]);

    await discardSharedBundle('doomed');

    const store = cacheStorage.storeFor(SHARE_CACHE_NAME)!;
    expect([...store.keys()].some((key) => key.includes('doomed'))).toBe(false);
    expect([...store.keys()].some((key) => key.includes('kept'))).toBe(true);
  });

  it('purges expired bundles and orphaned bytes, keeping live ones', async () => {
    await seedBundle(cacheStorage, 'live', [{ name: 'a.png', type: 'image/png' }]);
    await seedBundle(
      cacheStorage,
      'expired',
      [{ name: 'b.png', type: 'image/png' }],
      NOW - SHARE_STASH_TTL_MS - 1,
    );
    // Bytes whose index never committed, or was already swept.
    const cache = await cacheStorage.storage.open(SHARE_CACHE_NAME);
    await cache.put(shareFileKey('orphan', 0), new Response('lost'));

    await purgeExpiredSharedBundles(NOW);

    const keys = [...cacheStorage.storeFor(SHARE_CACHE_NAME)!.keys()];
    expect(keys.some((key) => key.includes('/live/'))).toBe(true);
    expect(keys.some((key) => key.includes('/expired/'))).toBe(false);
    expect(keys.some((key) => key.includes('/orphan/'))).toBe(false);
  });

  // The worker cannot know whose share it is -- a share can arrive with nobody
  // signed in -- so ownership is settled by the first authenticated reader.
  describe('ownership', () => {
    async function ownerOf(id: string): Promise<string | undefined> {
      const cache = await cacheStorage.storage.open(SHARE_CACHE_NAME);
      const response = await cache.match(shareIndexKey(id));
      const index = (await response!.json()) as SharedBundleIndex;
      return index.ownerUserId;
    }

    it('stamps an unclaimed bundle with the reader that read it', async () => {
      await seedBundle(cacheStorage, 'fresh', [
        { name: 'a.png', type: 'image/png' },
      ]);
      expect(await ownerOf('fresh')).toBeUndefined();

      const bundle = await readSharedBundle('fresh', VIEWER, NOW);

      expect(bundle!.index.ownerUserId).toBe(VIEWER);
      expect(await ownerOf('fresh')).toBe(VIEWER);
    });

    // The case sign-out alone never covered: the sharer was only NOTIFIED about
    // the share, so nothing but the notice ever observed it.
    it('claims on listing, not only on reading', async () => {
      await seedBundle(cacheStorage, 'noticed', [
        { name: 'a.png', type: 'image/png' },
      ]);

      const listed = await listSharedBundles(VIEWER, NOW);

      expect(listed.map((index) => index.ownerUserId)).toEqual([VIEWER]);
      expect(await ownerOf('noticed')).toBe(VIEWER);
    });

    it('keeps a claim across a second read, and does not re-stamp it', async () => {
      await seedBundle(cacheStorage, 'mine', [
        { name: 'a.png', type: 'image/png' },
      ]);

      await readSharedBundle('mine', VIEWER, NOW);
      const again = await readSharedBundle('mine', VIEWER, NOW);

      expect(again!.index.ownerUserId).toBe(VIEWER);
      expect(again!.files).toHaveLength(1);
      expect(await ownerOf('mine')).toBe(VIEWER);
    });

    // A share is one account's document. Reading as absent rather than refusing
    // is deliberate: the id came off a URL, and "whose is it" is not a question
    // this screen answers to whoever pasted one.
    it("reads another account's bundle as absent, and never lists it", async () => {
      await seedBundle(
        cacheStorage,
        'theirs',
        [{ name: 'a.png', type: 'image/png' }],
        NOW,
        OTHER,
      );

      expect(await readSharedBundle('theirs', VIEWER, NOW)).toBeNull();
      expect(await listSharedBundles(VIEWER, NOW)).toEqual([]);
      // Untouched: it is still the other account's to open.
      expect(await ownerOf('theirs')).toBe(OTHER);
    });

    it('leaves the owner alone for a reader that already owns it', async () => {
      await seedBundle(
        cacheStorage,
        'held',
        [{ name: 'a.png', type: 'image/png' }],
        NOW,
        VIEWER,
      );

      const bundle = await readSharedBundle('held', VIEWER, NOW);

      expect(bundle!.index.ownerUserId).toBe(VIEWER);
      expect(bundle!.files).toHaveLength(1);
    });

    // An unreadable stamp is not somebody's claim, and not everybody's either:
    // it reads as unclaimed, which the next authenticated reader settles.
    it('treats a non-string owner as unclaimed', async () => {
      const cache = await cacheStorage.storage.open(SHARE_CACHE_NAME);
      await cache.put(
        shareIndexKey('odd'),
        new Response(
          JSON.stringify({
            id: 'odd',
            createdAt: NOW,
            files: [],
            ownerUserId: 42,
          }),
        ),
      );

      const bundle = await readSharedBundle('odd', VIEWER, NOW);

      expect(bundle).not.toBeNull();
      expect(await ownerOf('odd')).toBe(VIEWER);
    });

    // Claiming an expired bundle would rewrite an index the purge is about to
    // delete, and there is nothing to protect: it can no longer be used.
    it('does not claim an expired bundle', async () => {
      await seedBundle(
        cacheStorage,
        'stale',
        [{ name: 'a.png', type: 'image/png' }],
        NOW - SHARE_STASH_TTL_MS - 1,
      );

      const bundle = await readSharedBundle('stale', VIEWER, NOW);

      expect(bundle!.expired).toBe(true);
      expect(await ownerOf('stale')).toBeUndefined();
    });

    // Nothing is shown to, or claimable by, a reader we cannot name -- the share
    // page stays on its loading state until the auth store answers.
    it('shows nothing to an unknown reader', async () => {
      await seedBundle(cacheStorage, 'waiting', [
        { name: 'a.png', type: 'image/png' },
      ]);

      expect(await listSharedBundles('', NOW)).toEqual([]);
      expect(await readSharedBundle('waiting', '', NOW)).toBeNull();
      expect(await ownerOf('waiting')).toBeUndefined();
    });

    // The purge is a lifetime sweep, not an access check: it runs from whichever
    // account happens to be signed in, and must not delete another account's
    // live share.
    it('purges by lifetime alone, leaving another account\'s live share', async () => {
      await seedBundle(
        cacheStorage,
        'theirs-live',
        [{ name: 'a.png', type: 'image/png' }],
        NOW,
        OTHER,
      );
      await seedBundle(
        cacheStorage,
        'theirs-old',
        [{ name: 'b.png', type: 'image/png' }],
        NOW - SHARE_STASH_TTL_MS - 1,
        OTHER,
      );

      await purgeExpiredSharedBundles(NOW);

      const keys = [...cacheStorage.storeFor(SHARE_CACHE_NAME)!.keys()];
      expect(keys.some((key) => key.includes('/theirs-live/'))).toBe(true);
      expect(keys.some((key) => key.includes('/theirs-old/'))).toBe(false);
    });
  });

  it('drops the whole stash on clear', async () => {
    await seedBundle(cacheStorage, 'one', [{ name: 'a.png', type: 'image/png' }]);

    await clearShareInbox();

    expect(await cacheStorage.storage.keys()).not.toContain(SHARE_CACHE_NAME);
  });
});

describe('share inbox without the Cache API', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // A browser with no Cache API (or a private window refusing storage) has an
  // empty inbox, not an error: the review screen explains, nothing throws.
  it('reads as an empty inbox and never rejects', async () => {
    vi.stubGlobal('caches', undefined);

    expect(isShareInboxSupported()).toBe(false);
    expect(await listSharedBundles(VIEWER, NOW)).toEqual([]);
    expect(await readSharedBundle('anything', VIEWER, NOW)).toBeNull();
    await expect(discardSharedBundle('anything')).resolves.toBeUndefined();
    await expect(purgeExpiredSharedBundles(NOW)).resolves.toBeUndefined();
    await expect(clearShareInbox()).resolves.toBeUndefined();
  });

  it('survives a Cache API that throws on open', async () => {
    vi.stubGlobal('caches', {
      open: () => {
        throw new DOMException('storage blocked');
      },
      delete: () => {
        throw new DOMException('storage blocked');
      },
    });

    expect(await listSharedBundles(VIEWER, NOW)).toEqual([]);
    expect(await readSharedBundle('anything', VIEWER, NOW)).toBeNull();
    await expect(clearShareInbox()).resolves.toBeUndefined();
  });
});
