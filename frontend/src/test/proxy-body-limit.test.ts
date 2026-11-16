import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import {
  DEFAULT_PROXY_BODY_LIMIT_BYTES,
  NEXT_PROXY_CLIENT_MAX_BODY_MB,
} from '@/lib/proxy-body-limit';

/**
 * The proxy's request-body ceiling, guarded because both ways of getting it
 * wrong fail silently.
 *
 * Too high, and it is the most memory one unauthenticated request can pin:
 * Next copies the body of every request `proxy.ts` matches into memory before
 * the proxy runs, up to this size, whatever the path. It used to be 308MB for
 * every path, so a single POST to the login route could hold that much.
 *
 * Too low relative to the proxy's own limit, and an oversized body is not
 * rejected but truncated: Next forwards the stump and the backend sees an
 * aborted request. The margin above `DEFAULT_PROXY_BODY_LIMIT_BYTES` is what
 * makes a truncated body always read as over the limit, so it is refused.
 *
 * The uploads that need more than this are not served by the proxy at all
 * (`LARGE_UPLOAD_ROUTES`), which `proxy-matcher.test.ts` asserts against the matcher.
 *
 * Resolved in a child process because `next.config.js` loads the next-intl
 * plugin, which cannot be required under the jsdom environment these tests use.
 */
describe('proxy request body limit', () => {
  const experimental = JSON.parse(
    execFileSync(
      process.execPath,
      [
        '-e',
        'Promise.resolve(require(process.argv[1])).then((c) => console.log(JSON.stringify(c.experimental ?? {})))',
        join(process.cwd(), 'next.config.js'),
      ],
      { encoding: 'utf8' },
    ),
  ) as Record<string, unknown>;

  function limitMb(value: unknown): number {
    if (typeof value === 'number') return value / (1024 * 1024);
    const match = /^(\d+(?:\.\d+)?)mb$/i.exec(String(value ?? ''));
    return match ? Number(match[1]) : Number.NaN;
  }

  it('is the value the proxy code is written against', () => {
    expect(limitMb(experimental.proxyClientMaxBodySize)).toBe(NEXT_PROXY_CLIENT_MAX_BODY_MB);
  });

  it('stays small, whatever the import limit is set to', () => {
    // The regression: this followed MNY_IMPORT_LIMIT_MB (300 by default).
    expect(limitMb(experimental.proxyClientMaxBodySize)).toBeLessThanOrEqual(16);
  });

  it('sits at least a megabyte above the limit the proxy enforces', () => {
    const defaultMb = DEFAULT_PROXY_BODY_LIMIT_BYTES / (1024 * 1024);
    expect(limitMb(experimental.proxyClientMaxBodySize)).toBeGreaterThanOrEqual(defaultMb + 1);
  });

  it('uses the non-deprecated option name', () => {
    // `middlewareClientMaxBodySize` still works and is what Next's own warning
    // names, but it is deprecated in favour of the proxy-era key.
    expect(experimental.middlewareClientMaxBodySize).toBeUndefined();
    expect(experimental.proxyClientMaxBodySize).toBeDefined();
  });
});
