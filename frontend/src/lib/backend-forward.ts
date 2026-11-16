import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { assertedClientAddress } from '@/lib/client-address';
import { createLogger } from '@/lib/logger';
import {
  DEFAULT_LOCALE,
  LOCALE_COOKIE,
  LOCALE_HEADER,
  isSupportedLocale,
  matchAcceptLanguage,
} from '@/i18n/config';

const logger = createLogger('BackendForward');

/**
 * What every path to the backend shares: the proxy (`src/proxy.ts`) and the
 * streaming upload route handlers (`large-upload-proxy.ts`) build the same
 * request, so a header rule written once holds on both.
 */

export function resolveRequestLocale(request: NextRequest): {
  locale: string;
  fromCookie: boolean;
} {
  const cookieValue = request.cookies.get(LOCALE_COOKIE)?.value;
  if (cookieValue && isSupportedLocale(cookieValue)) {
    return { locale: cookieValue, fromCookie: true };
  }
  const fromAccept = matchAcceptLanguage(request.headers.get('accept-language'));
  return { locale: fromAccept || DEFAULT_LOCALE, fromCookie: false };
}

export function backendBaseUrl(): string {
  return process.env.INTERNAL_API_URL || 'http://localhost:3001';
}

/**
 * Hop-by-hop headers (RFC 9110 section 7.6.1) describe one connection, not the
 * request, and undici refuses several of them outright on an outgoing fetch.
 */
const HOP_BY_HOP = [
  'connection',
  'keep-alive',
  'proxy-connection',
  'transfer-encoding',
  'te',
  'trailer',
  'upgrade',
  'expect',
];

/**
 * The headers a request carries to the backend.
 *
 * X-Forwarded-For is REPLACED, never passed through, so a browser's own cannot
 * reach the backend: the one address the trusted edge vouches for travels (read
 * from the right of the chain, `assertedClientAddress`), or nothing does. The
 * backend keys every per-IP rate limit on it. The literal `127.0.0.1` this used
 * to fall back to was worse than nothing -- it was recorded against every push
 * registration and trusted device, indistinguishable from a real connection
 * from the server itself.
 *
 * The resolved locale travels too, so the backend's nestjs-i18n HeaderResolver
 * renders error messages and email content in the right language.
 */
export function backendRequestHeaders(
  request: NextRequest,
  { stripHopByHop = false }: { stripHopByHop?: boolean } = {},
): Headers {
  const headers = new Headers(request.headers);
  headers.delete('host');
  if (stripHopByHop) {
    for (const name of HOP_BY_HOP) headers.delete(name);
  }
  const clientIp = assertedClientAddress(request.headers);
  if (clientIp) headers.set('x-forwarded-for', clientIp);
  else headers.delete('x-forwarded-for');
  headers.set(LOCALE_HEADER, resolveRequestLocale(request).locale);
  return headers;
}

/**
 * The backend connection dying after headers were already read (the backend
 * restarting, a reset connection) surfaces as `response.body` erroring while
 * Next pipes it to the client. By then the 200 is already committed, so there
 * is no turning this into the 502 a pre-flight `fetch()` failure gets; left
 * alone, the rejection reaches Next's own `pipeToNodeResponse`, which logs it
 * as an opaque, alarming-looking "failed to pipe response" with none of this
 * context. Reading it here instead turns that into a clean end of the stream,
 * logged with the real cause.
 */
function guardBackendStream(body: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
  const reader = body.getReader();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          controller.close();
          return;
        }
        controller.enqueue(value);
      } catch (error) {
        logger.error('Backend connection lost while streaming a response:', error);
        controller.close();
      }
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
}

/** The backend's response, streamed back as it arrives. */
export function responseFromBackend(response: Response): NextResponse {
  const responseHeaders = new Headers(response.headers);
  responseHeaders.delete('transfer-encoding');
  const body = response.body ? guardBackendStream(response.body) : response.body;
  return new NextResponse(body, {
    status: response.status,
    statusText: response.statusText,
    headers: responseHeaders,
  });
}

/**
 * A 413 answered by the frontend itself. The body mirrors the shape the
 * backend's own exception filter writes, so a client that reads `message` or
 * branches on `statusCode` treats both the same.
 */
export function payloadTooLarge(): NextResponse {
  return NextResponse.json(
    {
      statusCode: 413,
      message: 'Request body too large',
      error: 'Payload Too Large',
    },
    { status: 413 },
  );
}
