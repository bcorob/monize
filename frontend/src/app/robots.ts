import type { MetadataRoute } from 'next';

// A private finance app: nothing here is for a crawler. Without this route the
// request fell through to the full not-found page (the whole app shell, with no
// CSP, since the proxy matcher skips dotted paths).
export default function robots(): MetadataRoute.Robots {
  return {
    rules: { userAgent: '*', disallow: '/' },
  };
}
