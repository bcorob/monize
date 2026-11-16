import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  NOTIFICATION_PREFERENCE_CATEGORIES,
  NOTIFICATION_CATEGORY_CHANNELS,
  type CategoryChannelSupport,
} from './notification-preferences';

/**
 * The matrix categories and their per-category channel support are mirrored by
 * hand across the layers (nothing compiles the frontend against the backend).
 * If the backend exposes a new category, or changes which channels a category
 * exposes, and these copies do not follow, the settings matrix silently draws a
 * toggle the API forces off (or omits one it now honours) -- so hold both equal.
 */
const BACKEND_SERVICE = resolve(
  __dirname,
  '../../../backend/src/notification-center/notification-preference.service.ts',
);

function backendSource(): string {
  return readFileSync(BACKEND_SERVICE, 'utf8');
}

function parseBackendCategories(): string[] {
  const block = backendSource().match(
    /NOTIFICATION_PREFERENCE_CATEGORIES[^=]*=\s*\[([^\]]*)\]/,
  );
  if (!block) throw new Error('backend NOTIFICATION_PREFERENCE_CATEGORIES not found');
  return [...block[1].matchAll(/NotificationCategory\.(\w+)/g)].map((m) => m[1]);
}

/**
 * Every `channel: true|false` pair the backend writes, not a fixed list of
 * names: a parser that read four named fields would silently drop a fifth
 * backend channel and the `toEqual` below would still pass against a client
 * mirror missing it. Read generically, a new backend channel fails here until
 * the mirror (and therefore `CategoryChannelSupport`, and the matrix) carries it.
 */
function parseBackendChannelSupport(): Record<string, CategoryChannelSupport> {
  const source = backendSource();
  const block = source.match(
    /NOTIFICATION_CATEGORY_CHANNELS[\s\S]*?=\s*\{([\s\S]*?)\n\};/,
  );
  if (!block) throw new Error('backend NOTIFICATION_CATEGORY_CHANNELS not found');
  const out: Record<string, CategoryChannelSupport> = {};
  for (const entry of block[1].matchAll(
    /\[NotificationCategory\.(\w+)\]:\s*\{([^}]*)\}/g,
  )) {
    const [, category, body] = entry;
    const support: Record<string, boolean> = {};
    for (const pair of body.matchAll(/(\w+):\s*(true|false)/g)) {
      support[pair[1]] = pair[2] === 'true';
    }
    if (Object.keys(support).length === 0) {
      throw new Error(`backend ${category} declares no channels`);
    }
    out[category] = support as unknown as CategoryChannelSupport;
  }
  return out;
}

describe('notification preferences contract', () => {
  it('exposes exactly the categories the backend does, in order', () => {
    expect(parseBackendCategories()).toEqual([
      ...NOTIFICATION_PREFERENCE_CATEGORIES,
    ]);
  });

  it('mirrors the backend per-category channel support exactly', () => {
    expect(NOTIFICATION_CATEGORY_CHANNELS).toEqual(parseBackendChannelSupport());
  });
});
