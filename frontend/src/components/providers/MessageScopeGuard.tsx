'use client';

import { useEffect, useState } from 'react';
import { usePathname } from 'next/navigation';
import { NextIntlClientProvider, useLocale } from 'next-intl';
import type { AbstractIntlMessages } from 'next-intl';
import { isPublicPath } from '@/lib/public-paths';
import type { MessageScope } from '@/i18n/client-messages';
import { createLogger } from '@/lib/logger';

const logger = createLogger('MessageScopeGuard');

interface FullCatalog {
  locale: string;
  messages: AbstractIntlMessages;
}

/**
 * Keeps a signed-out page's trimmed catalog from reaching the signed-in app.
 *
 * The root layout picks the client catalog once, on the request that loaded
 * the document, and a soft navigation does not re-render it. So a sign-in on
 * /login followed by `router.push('/dashboard')` would render the app with
 * only the public namespaces. When the path leaves the public pages under a
 * public catalog, this renders nothing, fetches every namespace from
 * `/intl-messages` and provides them to the app below it.
 *
 * It fetches rather than calling `router.refresh()`: Firefox cancels an
 * in-flight refresh when the next navigation starts, Next answers the
 * cancelled refresh with a full reload of the current URL, and that reload
 * aborts the navigation the user (or a test) had just started.
 *
 * The landing path is exempt so a not-found page for a path the proxy never
 * saw (which is rendered with the public catalog) still renders. The fetched
 * catalog is kept per locale: a language change re-renders the root layout
 * with the new locale, and a catalog in the old one must not shadow it.
 */
export function MessageScopeGuard({
  scope,
  children,
}: {
  scope: MessageScope;
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  const locale = useLocale();
  const [landingPath] = useState(pathname);
  const [fullCatalog, setFullCatalog] = useState<FullCatalog | null>(null);
  const [failedLocale, setFailedLocale] = useState<string | null>(null);

  const catalog =
    scope === 'public' && fullCatalog?.locale === locale ? fullCatalog : null;
  const needsFullCatalog =
    scope === 'public' &&
    catalog === null &&
    failedLocale !== locale &&
    pathname !== landingPath &&
    !isPublicPath(pathname);

  useEffect(() => {
    if (!needsFullCatalog) return;
    let cancelled = false;
    fetch(`/intl-messages?locale=${encodeURIComponent(locale)}`, {
      credentials: 'same-origin',
    })
      .then((response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return response.json() as Promise<AbstractIntlMessages>;
      })
      .then(
        (messages) => {
          if (!cancelled) setFullCatalog({ locale, messages });
        },
        (error: unknown) => {
          // Usually the page navigating away mid-fetch. Never answered with a
          // reload: that is the navigation-aborting side effect this avoids.
          // Render the app on the catalog it has rather than nothing at all.
          logger.debug('Could not load the full catalog', error);
          if (!cancelled) setFailedLocale(locale);
        },
      );
    return () => {
      cancelled = true;
    };
  }, [needsFullCatalog, locale]);

  if (needsFullCatalog) return null;
  if (catalog === null) return <>{children}</>;
  return (
    <NextIntlClientProvider locale={catalog.locale} messages={catalog.messages}>
      {children}
    </NextIntlClientProvider>
  );
}
