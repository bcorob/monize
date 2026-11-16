import * as dns from "node:dns";
import { isIP } from "node:net";
import type { LookupFunction } from "node:net";
import { isPrivateIp, unbracketHost } from "../validators/safe-url.validator";
import { isAllowlistedPrivateBaseUrl } from "../validators/private-base-url-allowlist";

/**
 * Which addresses an AI provider request may connect to.
 *
 * - `public-only`: never a private, loopback, link-local or metadata address.
 *   Every cloud provider, whoever owns it.
 * - `public-or-allowlisted`: as above, except a host (and port) the operator
 *   named in `AI_PRIVATE_BASE_URL_ALLOWLIST`. A non-admin's self-hosted
 *   provider.
 * - `any`: no address restriction. An admin's self-hosted provider, and the
 *   operator's own `AI_DEFAULT_*` provider.
 *
 * The policy is enforced where the socket is opened (`publicOnlyLookup`), not
 * only where the URL is saved: a name that resolved publicly at save time and
 * privately now -- DNS rebinding, or a row stored before this rule -- is
 * refused at the connection it would otherwise have made.
 */
export type AiEgressPolicy = "public-only" | "public-or-allowlisted" | "any";

/** A provider request refused because of where it would have connected. */
export class AiEgressRefusedError extends Error {
  readonly code = "AI_EGRESS_REFUSED";

  constructor(host: string) {
    super(`Refusing an AI provider connection to a private address (${host})`);
    this.name = "AiEgressRefusedError";
  }
}

/**
 * Whether a request to this URL, under this policy, may go to a private
 * address at all. The answer picks the dispatcher: `false` sends the request
 * through the agent whose lookup refuses private answers.
 */
export function privateTargetAllowed(
  url: URL,
  policy: AiEgressPolicy,
): boolean {
  if (policy === "any") return true;
  if (policy === "public-or-allowlisted") {
    return isAllowlistedPrivateBaseUrl(url);
  }
  return false;
}

/**
 * The check a DNS lookup cannot make: an IP literal is connected to without
 * one, so `publicOnlyLookup` never sees `http://127.0.0.1/`. The URL parser
 * has already rewritten the decimal, hex and octal spellings to dotted form.
 */
export function assertPublicIpLiteral(url: URL): void {
  const host = unbracketHost(url.hostname.toLowerCase());
  if (isIP(host) && isPrivateIp(host)) {
    throw new AiEgressRefusedError(host);
  }
}

/** Every address a name resolves to, in `dns.lookup(..., { all: true })` form. */
export type ResolveAll = (
  hostname: string,
  options: dns.LookupOptions,
  callback: (
    error: NodeJS.ErrnoException | null,
    addresses: dns.LookupAddress[],
  ) => void,
) => void;

const systemResolveAll: ResolveAll = (hostname, options, callback) =>
  dns.lookup(hostname, { ...options, all: true }, (error, addresses) =>
    callback(error, (addresses ?? []) as dns.LookupAddress[]),
  );

/**
 * A `net.connect` lookup that resolves the name and refuses the connection if
 * ANY answer is a private address, so the address checked is the address
 * connected to. Checking one lookup and connecting after a second is the
 * window DNS rebinding uses. `resolveAll` is the system resolver outside tests.
 */
export function publicOnlyLookupVia(resolveAll: ResolveAll): LookupFunction {
  return ((
    hostname: string,
    options: dns.LookupOptions,
    callback: (
      error: NodeJS.ErrnoException | null,
      address: string | dns.LookupAddress[],
      family?: number,
    ) => void,
  ) => {
    resolveAll(hostname, options ?? {}, (error, list) => {
      if (error) return callback(error, "");
      if (list.length === 0) {
        const notFound: NodeJS.ErrnoException = new Error(
          `getaddrinfo ENOTFOUND ${hostname}`,
        );
        notFound.code = "ENOTFOUND";
        return callback(notFound, "");
      }
      if (list.some((entry) => isPrivateIp(entry.address))) {
        return callback(new AiEgressRefusedError(hostname), "");
      }
      if (options?.all) return callback(null, list);
      return callback(null, list[0].address, list[0].family);
    });
  }) as unknown as LookupFunction;
}

/** The public-only lookup over the system resolver. */
export const publicOnlyLookup = publicOnlyLookupVia(systemResolveAll);
