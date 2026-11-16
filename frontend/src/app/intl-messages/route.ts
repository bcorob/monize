import { NextResponse, type NextRequest } from 'next/server';
import { resolveLocale } from '@/i18n/config';
import { loadMessages } from '@/i18n/messages';

/**
 * Every namespace for one locale, for `MessageScopeGuard`.
 *
 * A page loaded on a signed-out route is handed only the public catalogs, and a
 * soft navigation into the app keeps that root layout. The guard fetches the rest
 * here rather than calling `router.refresh()`: a refresh that the browser cancels
 * (Firefox does, when the next navigation starts) makes Next fall back to a full
 * reload of the current URL, which in turn aborts that next navigation. A
 * cancelled fetch has no such side effect.
 *
 * Outside `/api` on purpose: the proxy forwards that prefix to the backend. Not a
 * public path, so it answers only a signed-in browser.
 */
export async function GET(request: NextRequest) {
  const locale = resolveLocale(request.nextUrl.searchParams.get('locale'));
  return NextResponse.json(await loadMessages(locale), {
    headers: { 'Cache-Control': 'private, no-cache' },
  });
}
