import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  DEFAULT_TRUSTED_PROXY_HOPS,
  assertedClientAddress,
  currentClientAddressConfig,
  resolveClientAddressConfig,
  type ClientAddressConfig,
} from './client-address';

function headers(entries: Record<string, string>): Headers {
  return new Headers(entries);
}

const hops = (trustedProxyHops: number): ClientAddressConfig => ({
  trustedProxyHops,
  clientIpHeader: null,
});

describe('assertedClientAddress', () => {
  /**
   * The regression. The first entry is whatever the client put there, because
   * every edge APPENDS its peer to the list. Reading it let any browser pick
   * its own rate-limit bucket by sending the header itself.
   */
  it('ignores spoofed leading entries and reads what the edge appended', () => {
    expect(
      assertedClientAddress(
        headers({ 'x-forwarded-for': '1.2.3.4, 5.6.7.8, 198.51.100.9' }),
        hops(1),
      ),
    ).toBe('198.51.100.9');
  });

  it('defaults to one trusted hop', () => {
    expect(DEFAULT_TRUSTED_PROXY_HOPS).toBe(1);
    expect(
      assertedClientAddress(
        headers({ 'x-forwarded-for': '1.2.3.4, 198.51.100.9' }),
        resolveClientAddressConfig({}).config,
      ),
    ).toBe('198.51.100.9');
  });

  it('reads the entry N from the right behind N trusted hops', () => {
    // CDN appends the client, the ingress appends the CDN.
    const chain = '1.2.3.4, 198.51.100.9, 10.0.0.2';
    expect(assertedClientAddress(headers({ 'x-forwarded-for': chain }), hops(2))).toBe(
      '198.51.100.9',
    );
    expect(assertedClientAddress(headers({ 'x-forwarded-for': chain }), hops(3))).toBe('1.2.3.4');
  });

  it('reads the last entry with no edge, the one Next filled from the socket', () => {
    expect(assertedClientAddress(headers({ 'x-forwarded-for': '203.0.113.5' }), hops(0))).toBe(
      '203.0.113.5',
    );
  });

  it('takes the leftmost entry of a chain shorter than the configured hops', () => {
    expect(assertedClientAddress(headers({ 'x-forwarded-for': '198.51.100.9' }), hops(2))).toBe(
      '198.51.100.9',
    );
  });

  it('ignores X-Real-IP unless the deployment named it', () => {
    // Traefik and Envoy pass a client-sent X-Real-IP straight through.
    expect(
      assertedClientAddress(
        headers({ 'x-real-ip': '1.2.3.4', 'x-forwarded-for': '198.51.100.9' }),
        hops(1),
      ),
    ).toBe('198.51.100.9');
  });

  it('believes the configured dedicated header', () => {
    const config = { trustedProxyHops: 1, clientIpHeader: 'cf-connecting-ip' };
    expect(
      assertedClientAddress(
        headers({
          'cf-connecting-ip': '2001:db8::1',
          'x-forwarded-for': '10.0.0.2',
        }),
        config,
      ),
    ).toBe('2001:db8::1');
  });

  it('falls back to the forwarded chain when the dedicated header is absent or a list', () => {
    const config = { trustedProxyHops: 1, clientIpHeader: 'x-real-ip' };
    expect(assertedClientAddress(headers({ 'x-forwarded-for': '198.51.100.9' }), config)).toBe(
      '198.51.100.9',
    );
    expect(
      assertedClientAddress(
        headers({
          'x-real-ip': '1.2.3.4, 5.6.7.8',
          'x-forwarded-for': '198.51.100.9',
        }),
        config,
      ),
    ).toBe('198.51.100.9');
  });

  it('trims the entry, since the chain is written with spaces', () => {
    expect(
      assertedClientAddress(headers({ 'x-forwarded-for': '10.0.0.2 , 198.51.100.9 ' }), hops(1)),
    ).toBe('198.51.100.9');
  });

  /**
   * Unknown is a state: the caller forwards no `X-Forwarded-For` at all rather
   * than a placeholder.
   */
  it.each([
    ['no headers at all', {}],
    ['only an X-Real-IP', { 'x-real-ip': '198.51.100.9' }],
    ['a whitespace X-Forwarded-For', { 'x-forwarded-for': '   ' }],
    ['an empty trailing entry', { 'x-forwarded-for': '10.0.0.2, ' }],
  ])('answers null for %s', (_name, entries) => {
    expect(assertedClientAddress(headers(entries), hops(1))).toBeNull();
  });
});

describe('resolveClientAddressConfig', () => {
  it('parses both settings', () => {
    expect(
      resolveClientAddressConfig({
        TRUSTED_PROXY_HOPS: ' 2 ',
        CLIENT_IP_HEADER: 'X-Real-IP',
      }),
    ).toEqual({
      config: { trustedProxyHops: 2, clientIpHeader: 'x-real-ip' },
      warnings: [],
    });
    expect(resolveClientAddressConfig({ TRUSTED_PROXY_HOPS: '0' }).config.trustedProxyHops).toBe(0);
  });

  it.each(['-1', '1.5', 'two', '11', '0x1'])(
    'falls back to the default for TRUSTED_PROXY_HOPS=%s and says so',
    (value) => {
      const resolved = resolveClientAddressConfig({
        TRUSTED_PROXY_HOPS: value,
      });
      expect(resolved.config.trustedProxyHops).toBe(DEFAULT_TRUSTED_PROXY_HOPS);
      expect(resolved.warnings).toHaveLength(1);
      expect(resolved.warnings[0]).toMatch(/TRUSTED_PROXY_HOPS/);
    },
  );

  it.each(['x-forwarded-for', 'x real ip', 'x-real-ip:'])(
    'ignores CLIENT_IP_HEADER=%s and says so',
    (value) => {
      const resolved = resolveClientAddressConfig({ CLIENT_IP_HEADER: value });
      expect(resolved.config.clientIpHeader).toBeNull();
      expect(resolved.warnings[0]).toMatch(/CLIENT_IP_HEADER/);
    },
  );
});

describe('currentClientAddressConfig', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('reads the environment', () => {
    vi.stubEnv('TRUSTED_PROXY_HOPS', '2');
    vi.stubEnv('CLIENT_IP_HEADER', 'cf-connecting-ip');
    expect(currentClientAddressConfig()).toEqual({
      trustedProxyHops: 2,
      clientIpHeader: 'cf-connecting-ip',
    });
  });

  it('logs an unusable value once, not once per request', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.stubEnv('TRUSTED_PROXY_HOPS', 'many');
    vi.stubEnv('CLIENT_IP_HEADER', '');
    currentClientAddressConfig();
    currentClientAddressConfig();
    expect(currentClientAddressConfig().trustedProxyHops).toBe(DEFAULT_TRUSTED_PROXY_HOPS);
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });
});
