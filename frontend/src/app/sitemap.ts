import type { MetadataRoute } from 'next';

// Deliberately empty: there are no public pages to index. Served so a probe
// for /sitemap.xml gets a small XML document instead of the full not-found
// page, which renders the app shell outside the proxy's CSP.
export default function sitemap(): MetadataRoute.Sitemap {
  return [];
}
