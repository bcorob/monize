'use client';

import { useEffect } from 'react';
import { usePathname } from 'next/navigation';
import { purgeExpiredSharedBundles } from '@/lib/share-inbox';
import { SHARE_PAGE_PATH } from '@/lib/share-target';

/**
 * The app's half of the stash lifetime sweep. Renders nothing.
 *
 * This ran inside `ShareInboxNotice` until that banner was removed, and it is
 * kept as its own component rather than deleted with it: the banner's UI was
 * redundant, its sweep is not. The worker sweeps on `activate` and before each
 * new share, so without this a returning visit that neither updates the worker
 * nor shares anything new never ages a stash out -- files the user shared would
 * sit on the device longer than the declared lifetime says they do
 * (INV-SHARE-003).
 *
 * Never on `/share`, where an expired bundle is deliberately still readable so
 * the review screen can say "expired" rather than "nothing here". That gate is
 * the reason this is a component with a pathname and not a call in a provider.
 *
 * Not gated on the reader: this is a lifetime sweep, not an access check, and
 * `purgeExpiredSharedBundles` decides on `createdAt` alone. Ownership is
 * INV-SHARE-005's job, enforced where a bundle is read.
 */
export function ShareStashSweeper() {
  const pathname = usePathname();

  useEffect(() => {
    if (pathname === SHARE_PAGE_PATH) return;
    // `share-inbox` treats an unusable Cache API as an empty inbox and resolves
    // rather than rejecting, so this needs no catch -- and a catch here would
    // be a rejection handler on a fire-and-forget call, not a repair.
    void purgeExpiredSharedBundles();
  }, [pathname]);

  return null;
}
