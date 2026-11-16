import { createLogger } from '@/lib/logger';

/**
 * The client address the deployment's edge vouches for, for the proxy to pass
 * on to the backend -- or `null` when nothing does.
 *
 * Next.js middleware has no access to the connecting socket (`NextRequest.ip`
 * was Vercel-only and was removed in Next 15), so the ONLY thing this layer can
 * know about the client's address is what something in front of it put in a
 * header. The backend keys every per-IP rate limit on the value this returns,
 * so it must be a value the client cannot choose.
 *
 * ## Why the chain is read from the right
 *
 * Every hop APPENDS the peer it heard from to `X-Forwarded-For` (nginx and
 * ingress-nginx with `$proxy_add_x_forwarded_for`, Traefik, Envoy / Gateway API
 * implementations, most cloud load balancers), and Next itself only fills the
 * header from the socket when it is absent. So whatever a client sends lands at
 * the LEFT of the list, and the entries a trusted hop wrote are the rightmost
 * ones. With `TRUSTED_PROXY_HOPS` = N proxies in front of the frontend, the
 * client is the entry N positions from the right: N=1 is the last entry, the
 * address the nearest edge appended, which no client can forge. Reading the
 * first entry -- the conventional "originating client" position -- let any
 * browser choose its own rate-limit bucket by sending the header itself.
 *
 * `X-Real-IP` is NOT read by default for the same reason: nginx overwrites it,
 * but Traefik and Envoy pass a client-sent one straight through. A deployment
 * whose edge overwrites a dedicated header (`X-Real-IP` under nginx,
 * `CF-Connecting-IP` behind Cloudflare) names it in `CLIENT_IP_HEADER`, and only
 * then is that header believed.
 *
 * `TRUSTED_PROXY_HOPS=0` means nothing is in front of the frontend: the last
 * entry is then the socket address Next filled in when the client sent no
 * header -- and whatever the client sent when it did, which no configuration of
 * this layer can prevent. A frontend reachable directly from the internet
 * should be put behind a reverse proxy.
 *
 * ## `null`
 *
 * Unknown is a state. The predecessor of this function fell back to the literal
 * `"127.0.0.1"`, which every deployment without an `X-Real-IP`-setting edge then
 * recorded against every registration and every trusted device -- an address
 * nobody was at, indistinguishable from a genuine loopback connection.
 */

const logger = createLogger('ClientAddress');

/** Proxy hops assumed in front of the frontend when nothing says otherwise. */
export const DEFAULT_TRUSTED_PROXY_HOPS = 1;

/** Upper bound on `TRUSTED_PROXY_HOPS`; no real deployment chains more. */
export const MAX_TRUSTED_PROXY_HOPS = 10;

/** A lower-case HTTP header name (RFC 9110 token characters in practice). */
const HEADER_NAME = /^[a-z0-9-]+$/;

export interface ClientAddressConfig {
  /** Proxies in front of the frontend that append to `X-Forwarded-For`. */
  readonly trustedProxyHops: number;
  /** A header the edge overwrites with the client address, or `null`. */
  readonly clientIpHeader: string | null;
}

export interface ResolvedClientAddressConfig {
  readonly config: ClientAddressConfig;
  /** Why a configured value was ignored; empty when both were usable. */
  readonly warnings: readonly string[];
}

/**
 * Parse `TRUSTED_PROXY_HOPS` and `CLIENT_IP_HEADER`. A value that does not
 * parse falls back to the safe default and says so, rather than throwing in
 * the request path or silently trusting something the operator did not name.
 */
export function resolveClientAddressConfig(
  env: Readonly<Record<string, string | undefined>>,
): ResolvedClientAddressConfig {
  const warnings: string[] = [];

  let trustedProxyHops = DEFAULT_TRUSTED_PROXY_HOPS;
  const rawHops = env.TRUSTED_PROXY_HOPS?.trim() ?? '';
  if (rawHops !== '') {
    const parsed = /^\d+$/.test(rawHops) ? Number(rawHops) : Number.NaN;
    if (Number.isInteger(parsed) && parsed <= MAX_TRUSTED_PROXY_HOPS) {
      trustedProxyHops = parsed;
    } else {
      warnings.push(
        `TRUSTED_PROXY_HOPS="${rawHops}" is not an integer from 0 to ` +
          `${MAX_TRUSTED_PROXY_HOPS}; using ${DEFAULT_TRUSTED_PROXY_HOPS}.`,
      );
    }
  }

  let clientIpHeader: string | null = null;
  const rawHeader = env.CLIENT_IP_HEADER?.trim().toLowerCase() ?? '';
  if (rawHeader !== '') {
    if (HEADER_NAME.test(rawHeader) && rawHeader !== 'x-forwarded-for') {
      clientIpHeader = rawHeader;
    } else {
      warnings.push(
        `CLIENT_IP_HEADER="${rawHeader}" is not a single-address header name; ` +
          'ignoring it and reading X-Forwarded-For.',
      );
    }
  }

  return { config: { trustedProxyHops, clientIpHeader }, warnings };
}

let cached: { key: string; config: ClientAddressConfig } | null = null;

/**
 * The configuration for this process, read from `process.env` and parsed once
 * per distinct value, so a bad setting is logged once rather than per request.
 */
export function currentClientAddressConfig(): ClientAddressConfig {
  const env = {
    TRUSTED_PROXY_HOPS: process.env.TRUSTED_PROXY_HOPS,
    CLIENT_IP_HEADER: process.env.CLIENT_IP_HEADER,
  };
  const key = `${env.TRUSTED_PROXY_HOPS ?? ''}\u0000${env.CLIENT_IP_HEADER ?? ''}`;
  if (cached?.key === key) return cached.config;
  const { config, warnings } = resolveClientAddressConfig(env);
  for (const warning of warnings) logger.warn(warning);
  cached = { key, config };
  return config;
}

export function assertedClientAddress(
  headers: Headers,
  config: ClientAddressConfig = currentClientAddressConfig(),
): string | null {
  if (config.clientIpHeader) {
    const dedicated = singleAddress(headers.get(config.clientIpHeader));
    if (dedicated) return dedicated;
  }
  return forwardedAddress(headers.get('x-forwarded-for'), config.trustedProxyHops);
}

/**
 * The entry `hops` positions from the right of a forwarded chain (the last
 * entry for 0 or 1). A chain shorter than `hops` reached the frontend through
 * fewer proxies than configured, so every entry in it was written by one of
 * them and the leftmost is the closest thing to the client there is.
 */
function forwardedAddress(value: string | null, hops: number): string | null {
  if (!value) return null;
  const entries = value.split(',').map((entry) => entry.trim());
  const index = Math.max(0, entries.length - Math.max(hops, 1));
  const entry = entries[index] ?? '';
  return entry.length > 0 ? entry : null;
}

/**
 * A header the edge overwrites carries one address. A list there means the
 * edge appended rather than overwrote, so the header is not what the operator
 * described and is not believed.
 */
function singleAddress(value: string | null): string | null {
  const trimmed = value?.trim() ?? '';
  if (trimmed.length === 0 || trimmed.includes(',')) return null;
  return trimmed;
}
