'use client';

import { useEffect } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { useTheme } from '@/contexts/ThemeContext';
import { getLocaleDir } from '@/i18n/config';

export const OFFLINE_STRINGS_MESSAGE_TYPE = 'monize-offline-strings';

// The service worker's offline fallback page is synthesized inside sw.js,
// where next-intl and the theme CSS cannot reach. This component hands the
// worker the localized copy, the resolved theme, and the page colours the
// active palette actually painted, whenever the app runs -- so the fallback
// the user eventually sees matches their language and look. Until the first
// handshake the worker falls back to its built-in English strings and stock
// palette.
export function OfflineFallbackSync() {
  const t = useTranslations('layout');
  const locale = useLocale();
  const { resolvedTheme, colorTheme } = useTheme();

  useEffect(() => {
    if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) {
      return;
    }
    let cancelled = false;

    // Deferred a frame: parent effects run after child effects, so at this
    // effect's own run ThemeProvider has not yet applied the dark class /
    // data-theme attribute for the state this effect is reacting to. By the
    // next animation frame the document wears the final palette and the
    // computed body colours are the ones on screen.
    const frame = requestAnimationFrame(() => {
      const styles = window.getComputedStyle(document.body);
      const message = {
        type: OFFLINE_STRINGS_MESSAGE_TYPE,
        payload: {
          lang: locale,
          dir: getLocaleDir(locale),
          theme: resolvedTheme,
          background: styles.backgroundColor?.trim() ?? '',
          foreground: styles.color?.trim() ?? '',
          title: t('offlineFallback.title'),
          message: t('offlineFallback.message'),
          retry: t('offlineFallback.retry'),
        },
      };
      navigator.serviceWorker.ready
        .then((registration) => {
          if (cancelled) return;
          registration.active?.postMessage(message);
        })
        .catch(() => {
          // No registration -- nothing to sync.
        });
    });

    return () => {
      cancelled = true;
      cancelAnimationFrame(frame);
    };
  }, [t, locale, resolvedTheme, colorTheme]);

  return null;
}
