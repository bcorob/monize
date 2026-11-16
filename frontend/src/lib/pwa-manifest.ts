import type { MetadataRoute } from 'next';
import type { ColorTheme } from './color-themes';
import { bootPageColor, type ResolvedTheme } from './pwa-theme';
import {
  SHARE_TARGET_ACCEPT,
  SHARE_TARGET_FILES_FIELD,
  SHARE_TARGET_PATH,
} from './share-target';

/**
 * `share_target` is a real manifest member that Next's Manifest type does not
 * model, so it is declared here rather than cast away at the call site.
 *
 * Files only: no `title`, `text` or `url` params. Declaring those would put
 * Monize in the share sheet for every piece of text on the device, and a plain
 * text share has no destination here that is not a guess.
 */
type ShareTargetManifest = MetadataRoute.Manifest & {
  share_target: {
    action: string;
    method: 'POST';
    enctype: 'multipart/form-data';
    params: { files: { name: string; accept: string[] }[] };
  };
};

// The OS builds the PWA splash screen from the manifest's background_color,
// icon and name, captured when the manifest was last fetched -- there is no
// media query in the manifest format. Serving the manifest dynamically from
// the resolved-theme and colour-palette cookies is the only lever: browsers
// re-check the manifest on launch, so the splash follows the user's theme
// from the next launch on. With no cookies (fresh browser, cookie expired)
// the default light palette is served, matching the pre-cookie behaviour.
export function buildManifest(
  theme: ResolvedTheme | null,
  colorTheme: ColorTheme | null = null,
): ShareTargetManifest {
  const page = bootPageColor(colorTheme, theme);
  return {
    // The manifest URL varies with the theme query string, so the app's
    // identity is pinned explicitly -- every variant is the same app.
    id: '/',
    name: 'Monize - Personal Finance Manager',
    short_name: 'Monize',
    description: 'Track your finances, manage budgets, and monitor investments',
    start_url: '/',
    display: 'standalone',
    background_color: page,
    theme_color: page,
    orientation: 'portrait-primary',
    // Put Monize in the OS share sheet for receipts and statement exports. The
    // POST is answered by the service worker, which stashes the files and sends
    // the user to /share to review them -- nothing is imported or attached
    // without an explicit action there. The accept list is derived in
    // lib/share-target.ts from what the server already takes, so the share
    // sheet cannot offer a type an upload would refuse.
    share_target: {
      action: SHARE_TARGET_PATH,
      method: 'POST',
      enctype: 'multipart/form-data',
      params: {
        files: [
          { name: SHARE_TARGET_FILES_FIELD, accept: [...SHARE_TARGET_ACCEPT] },
        ],
      },
    },
    icons: [
      {
        src: '/icons/icon-192x192.png',
        sizes: '192x192',
        type: 'image/png',
        purpose: 'any',
      },
      {
        src: '/icons/icon-512x512.png',
        sizes: '512x512',
        type: 'image/png',
        purpose: 'any',
      },
      {
        src: '/icons/icon-maskable-192x192.png',
        sizes: '192x192',
        type: 'image/png',
        purpose: 'maskable',
      },
      {
        src: '/icons/icon-maskable-512x512.png',
        sizes: '512x512',
        type: 'image/png',
        purpose: 'maskable',
      },
    ],
  };
}
