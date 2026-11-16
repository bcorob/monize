import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { NextRequest } from 'next/server';
import { forwardLargeUpload } from './large-upload-proxy';
import { LARGE_UPLOAD_ROUTES } from './proxy-body-limit';

const BASE = 'https://monize.example';
const MIB = 1024 * 1024;

function upload(
  path: string,
  body: BodyInit | null,
  headers: Record<string, string> = {},
): NextRequest {
  return new NextRequest(`${BASE}${path}`, {
    method: 'POST',
    headers,
    body,
    duplex: 'half',
  } as ConstructorParameters<typeof NextRequest>[1]);
}

/** A body of `size` bytes delivered in 1 MiB chunks, never declared. */
function chunkedBody(size: number): ReadableStream<Uint8Array> {
  let sent = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (sent >= size) {
        controller.close();
        return;
      }
      const chunk = Math.min(MIB, size - sent);
      sent += chunk;
      controller.enqueue(new Uint8Array(chunk));
    },
  });
}

describe('forwardLargeUpload', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    // Behaves like undici: the request body is consumed, and a body stream
    // that errors rejects the fetch with the stream's error as its cause.
    fetchMock.mockImplementation(async (_url: string, init: RequestInit) => {
      if (init.body instanceof ReadableStream) {
        const reader = init.body.getReader();
        try {
          for (;;) {
            const { done } = await reader.read();
            if (done) break;
          }
        } catch (cause) {
          throw new TypeError('fetch failed', { cause });
        }
      }
      return new Response('{"ok":true}', {
        status: 201,
        headers: { 'content-type': 'application/json' },
      });
    });
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    fetchMock.mockReset();
  });

  it('streams the body to the same backend path, never buffering it', async () => {
    const response = await forwardLargeUpload(
      upload('/api/v1/backup/restore?x=1', chunkedBody(3 * MIB), {
        'content-type': 'application/gzip',
      }),
    );

    expect(response.status).toBe(201);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit & { duplex?: string }];
    expect(url).toBe('http://localhost:3001/api/v1/backup/restore?x=1');
    expect(init.body).toBeInstanceOf(ReadableStream);
    expect(init.duplex).toBe('half');
  });

  it('refuses a declared length over the route ceiling without reading or forwarding', async () => {
    const response = await forwardLargeUpload(
      upload('/api/v1/ai/query', chunkedBody(MIB), {
        'content-length': String(31 * MIB),
      }),
    );

    expect(response.status).toBe(413);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('cuts off an undeclared body at the route ceiling with 413', async () => {
    const response = await forwardLargeUpload(
      upload('/api/v1/transactions/0c1e/attachments', chunkedBody(22 * MIB)),
    );

    expect(response.status).toBe(413);
  });

  it('replaces a client-sent X-Forwarded-For and drops hop-by-hop headers', async () => {
    await forwardLargeUpload(
      upload('/api/v1/import/mny/parse', chunkedBody(10), {
        'x-forwarded-for': '1.2.3.4, 198.51.100.9',
        connection: 'keep-alive',
      }),
    );

    const headers = new Headers((fetchMock.mock.calls[0][1] as RequestInit).headers);
    expect(headers.get('x-forwarded-for')).toBe('198.51.100.9');
    expect(headers.has('connection')).toBe(false);
    expect(headers.has('host')).toBe(false);
  });

  it('answers 502 when the backend cannot be reached', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('fetch failed'));
    const response = await forwardLargeUpload(upload('/api/v1/ai/query/stream', '{}'));
    expect(response.status).toBe(502);
  });

  it('is what every large-upload route handler answers with', async () => {
    type Handler = (request: NextRequest) => Promise<Response>;
    const modules = import.meta.glob('/src/app/api/v1/**/route.ts') as Record<
      string,
      () => Promise<Partial<Record<'GET' | 'POST', Handler>>>
    >;
    const handlerFiles = Object.keys(modules).filter((file) => !file.includes('/health/'));
    expect(handlerFiles.length).toBeGreaterThanOrEqual(LARGE_UPLOAD_ROUTES.length);

    for (const file of handlerFiles) {
      const path = file
        .replace(/^\/src\/app/, '')
        .replace(/\/route\.ts$/, '')
        .replace(/\[[^\]]+\]/g, 'sample-id');
      const handlers = await modules[file]();
      fetchMock.mockClear();
      expect(handlers.POST, file).toBeDefined();
      const response = await handlers.POST!(upload(path, chunkedBody(10)));
      expect(response.status, file).toBe(201);
      expect(fetchMock.mock.calls[0][0], file).toBe(`http://localhost:3001${path}`);
      if (handlers.GET) {
        const listing = await handlers.GET(new NextRequest(`${BASE}${path}`));
        expect(listing.status, file).toBe(201);
      }
    }
  });
});

/**
 * Every route handler that forwards through `forwardLargeUpload` must be one of
 * `LARGE_UPLOAD_ROUTES`, or it would answer 404 -- and every large route must
 * have a handler, or it would reach nothing once the proxy stopped matching it.
 */
describe('large upload route handlers', () => {
  const apiRoot = join(process.cwd(), 'src', 'app', 'api');

  function routeFiles(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) return routeFiles(full);
      return name === 'route.ts' ? [full] : [];
    });
  }

  const forwarding = routeFiles(apiRoot)
    .filter((file) => readFileSync(file, 'utf8').includes('forwardLargeUpload'))
    .map((file) => {
      const segments = relative(join(process.cwd(), 'src', 'app'), file)
        .split(sep)
        .slice(0, -1)
        .map((segment) => (segment.startsWith('[') ? 'sample-id' : segment));
      return `/${segments.join('/')}`;
    });

  it('found the handlers', () => {
    expect(forwarding).toContain('/api/v1/backup/restore');
  });

  it('pairs each handler with exactly one ceiling, and each ceiling with a handler', () => {
    for (const path of forwarding) {
      expect(
        LARGE_UPLOAD_ROUTES.filter((route) => route.pattern.test(path)),
        path,
      ).toHaveLength(1);
    }
    for (const route of LARGE_UPLOAD_ROUTES) {
      expect(forwarding.some((path) => route.pattern.test(path)), String(route.pattern)).toBe(
        true,
      );
    }
  });
});
