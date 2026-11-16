'use client';

import { useMemo } from 'react';

/**
 * The policy the email's own document starts with: nothing is fetched (`default-src
 * 'none'`) except images and fonts that arrive inside the markup itself (`data:`,
 * and `cid:` for an inline part, which resolves to nothing here), and inline
 * styles are what a mail layout is made of. Remote images, web fonts, stylesheets,
 * tracking pixels, frames and forms never load.
 */
export const EMAIL_FRAME_CSP = "default-src 'none'; img-src data: cid:; style-src 'unsafe-inline'; font-src data:";

/**
 * The document a sandboxed frame shows for an email's HTML. It STARTS with the
 * policy meta and `<base target="_blank">` (so a link, which the sandbox will not
 * open anyway, never targets the frame itself), and the email's markup follows,
 * so nothing it contains can come before the policy. A DNS-prefetch hint is
 * switched off too: a `<link rel="dns-prefetch">` is not a fetch the policy sees.
 */
export function buildEmailFrameDocument(html: string): string {
  return (
    `<meta http-equiv="Content-Security-Policy" content="${EMAIL_FRAME_CSP}">` +
    '<base target="_blank">' +
    '<meta http-equiv="x-dns-prefetch-control" content="off">' +
    html
  );
}

interface EmailHtmlFrameProps {
  /** The HTML part as the sender wrote it. Hostile input: it is data for the frame, never markup of this page. */
  html: string;
  title: string;
}

/**
 * An email's HTML, shown the only safe way: in an `<iframe sandbox="" srcDoc>`.
 *
 * - `sandbox=""` (no tokens at all): no scripts, no same-origin access to this
 *   app (the document is an opaque origin, so no cookie or storage of ours is
 *   reachable), no forms, no popups, no top navigation, no plugins.
 * - The CSP meta above is the second wall: even markup that would load a remote
 *   image (a tracking pixel) is refused, so opening an email tells its sender nothing.
 * - The app's own policy (`proxy.ts`: `default-src 'self'`, inline styles allowed)
 *   is inherited by a `srcdoc` document and already forbids what the meta forbids;
 *   the same `frame-src` that covers this frame also refuses a `meta refresh` to
 *   another address. Nothing about this frame needs a looser app policy.
 *
 * The HTML is NEVER put into this page's DOM: no `dangerouslySetInnerHTML`
 * anywhere in this tree, and `EmailHtmlFrame.test.tsx` fails on one here.
 */
export function EmailHtmlFrame({ html, title }: EmailHtmlFrameProps) {
  const srcDoc = useMemo(() => buildEmailFrameDocument(html), [html]);
  return (
    <iframe
      title={title}
      sandbox=""
      srcDoc={srcDoc}
      referrerPolicy="no-referrer"
      className="h-96 w-full resize-y rounded-lg border border-gray-200 bg-white dark:border-gray-700"
    />
  );
}
