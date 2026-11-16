import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { createLogger } from '@/lib/logger';
import {
  backendBaseUrl,
  backendRequestHeaders,
  payloadTooLarge,
  responseFromBackend,
} from '@/lib/backend-forward';
import {
  BodyTooLargeError,
  LARGE_UPLOAD_ROUTES,
  declaresBodyOver,
  limitBodyStream,
} from '@/lib/proxy-body-limit';

const logger = createLogger('LargeUploadProxy');

/**
 * Forward one of the `LARGE_UPLOAD_ROUTES` to the backend, streaming the body.
 *
 * These paths are excluded from the proxy's matcher, so Next does not copy
 * their bodies into memory first (`proxy-body-limit.ts` says why that matters),
 * and this handler reads the request as it arrives: an oversized declared
 * length is refused before a byte is read, and an undeclared one is cut off at
 * the route's ceiling. The frontend holds at most the chunk in flight.
 *
 * Streaming is safe here where it was not in the proxy: the body is the route
 * handler's own request stream, which nothing else has read or locked.
 */
export async function forwardLargeUpload(request: NextRequest): Promise<NextResponse> {
  const { pathname, search } = request.nextUrl;
  const route = LARGE_UPLOAD_ROUTES.find((candidate) => candidate.pattern.test(pathname));
  if (!route) {
    // A route handler registered without a ceiling. Refused rather than
    // forwarded unbounded.
    logger.error(`No upload ceiling configured for ${pathname}`);
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }
  const limitBytes = route.limitBytes();
  if (declaresBodyOver(request.headers, limitBytes)) {
    return payloadTooLarge();
  }

  const hasBody = request.method !== 'GET' && request.method !== 'HEAD' && request.body !== null;
  const body = hasBody && request.body ? limitBodyStream(request.body, limitBytes) : undefined;
  const url = new URL(pathname + search, backendBaseUrl());
  logger.debug(`${request.method} ${pathname} -> ${url.origin} (streamed)`);

  try {
    const response = await fetch(url.toString(), {
      method: request.method,
      headers: backendRequestHeaders(request, { stripHopByHop: true }),
      body,
      redirect: 'manual',
      // Required by undici for a streamed request body.
      duplex: 'half',
    } as RequestInit & { duplex: 'half' });
    return responseFromBackend(response);
  } catch (error) {
    if (isBodyTooLarge(error)) {
      return payloadTooLarge();
    }
    logger.error('Upload proxy error:', error);
    return NextResponse.json({ error: 'Backend unavailable' }, { status: 502 });
  }
}

/** undici wraps a body stream's error as the `cause` of its own TypeError. */
function isBodyTooLarge(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current; depth++) {
    if (current instanceof BodyTooLargeError) return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}
