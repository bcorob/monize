import { cookies } from 'next/headers';
import { NextRequest, NextResponse } from 'next/server';
import { isColorTheme } from '@/lib/color-themes';
import { buildManifest } from '@/lib/pwa-manifest';
import {
  COLOR_THEME_COOKIE,
  RESOLVED_THEME_COOKIE,
  isResolvedTheme,
} from '@/lib/pwa-theme';

// A hand-written route handler rather than Next's manifest.ts convention,
// for two reasons: the splash palette depends on the resolved theme and
// colour palette (see lib/pwa-manifest.ts), and the browser only sends
// cookies on a manifest fetch when the <link rel="manifest"> carries
// crossorigin="use-credentials" -- which the convention's auto-generated
// link cannot express. layout.tsx renders that link explicitly.
//
// The theme arrives two ways, and both matter. The cookies are the fresher
// signal, but only page-initiated fetches reliably carry them: the update
// check an *installed* app performs re-fetches the manifest URL it was
// installed with, and may do so without credentials. So layout.tsx also
// encodes the theme into the link's query string -- the installed app then
// keeps re-checking a URL that names the theme it was installed under, and
// a cookieless update check still resolves the right palette. Cookies, when
// present, override the query so a later theme change is picked up too.
export async function GET(request: NextRequest) {
  const cookieStore = await cookies();
  const params = request.nextUrl.searchParams;

  const rawTheme =
    cookieStore.get(RESOLVED_THEME_COOKIE)?.value ?? params.get('theme');
  const rawColorTheme =
    cookieStore.get(COLOR_THEME_COOKIE)?.value ?? params.get('palette');
  const theme = isResolvedTheme(rawTheme) ? rawTheme : null;
  const colorTheme = isColorTheme(rawColorTheme) ? rawColorTheme : null;

  return NextResponse.json(buildManifest(theme, colorTheme), {
    headers: {
      'Content-Type': 'application/manifest+json',
      // Let the browser revalidate on each manifest update check so a theme
      // change is picked up on the next launch rather than a cache lifetime.
      'Cache-Control': 'no-cache',
    },
  });
}
