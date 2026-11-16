import { BlockList, isIP } from "node:net";
import type { LookupFunction } from "node:net";

const privateNetworks = new BlockList();
privateNetworks.addSubnet("10.0.0.0", 8, "ipv4");
privateNetworks.addSubnet("172.16.0.0", 12, "ipv4");
privateNetworks.addSubnet("192.168.0.0", 16, "ipv4");
privateNetworks.addSubnet("100.64.0.0", 10, "ipv4"); // CGNAT, Tailscale
privateNetworks.addSubnet("198.18.0.0", 15, "ipv4"); // benchmarking
const privateIpv6Networks = new BlockList();
privateIpv6Networks.addSubnet("fc00::", 7, "ipv6");
export interface PrivatePushEndpoint {
  hostname: string;
  address: string;
  family: 4 | 6;
}

/** Operator-only configuration. No wildcards, CIDRs, userinfo or path prefixes. */
export function privatePushEndpoints(
  raw = process.env.UNIFIEDPUSH_PRIVATE_ENDPOINTS,
): Map<string, PrivatePushEndpoint> {
  const result = new Map<string, PrivatePushEndpoint>();
  if (!raw?.trim()) return result;
  const invalid = () =>
    new Error(
      "Invalid UNIFIEDPUSH_PRIVATE_ENDPOINTS: expected HTTPS DNS origins mapped to RFC1918, CGNAT (100.64.0.0/10), 198.18.0.0/15 or IPv6 ULA addresses",
    );
  try {
    if (raw.length > 16384) throw invalid();
    const values: unknown = JSON.parse(raw);
    if (
      !values ||
      typeof values !== "object" ||
      Array.isArray(values) ||
      Object.keys(values).length > 32
    )
      throw invalid();
    for (const [name, address] of Object.entries(values)) {
      const url = new URL(name);
      if (
        url.protocol !== "https:" ||
        url.username ||
        url.password ||
        url.search ||
        url.hash ||
        url.pathname !== "/" ||
        isIP(url.hostname.replace(/^\[|\]$/g, "")) ||
        !/^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/.test(url.hostname) ||
        typeof address !== "string"
      )
        throw invalid();
      const family = isIP(address);
      if (
        (family !== 4 && family !== 6) ||
        !(family === 4
          ? privateNetworks.check(address, "ipv4")
          : privateIpv6Networks.check(address, "ipv6")) ||
        result.has(url.origin)
      )
        throw invalid();
      result.set(url.origin, { hostname: url.hostname, address, family });
    }
    return result;
  } catch {
    throw invalid();
  }
}

export function privatePushEndpoint(
  endpoint: string,
  transport?: string,
): PrivatePushEndpoint | undefined {
  if (transport !== "unifiedpush") return undefined;
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return undefined;
  }
  if (url.username || url.password || url.hash || url.protocol !== "https:")
    return undefined;
  return privatePushEndpoints().get(url.origin);
}

/** Connect to the operator's address, never a second DNS answer. TLS still uses the hostname. */
export function pinnedPushLookup(pin: PrivatePushEndpoint): LookupFunction {
  return ((
    hostname: string,
    options: { all?: boolean },
    callback: (...args: any[]) => void,
  ) => {
    if (hostname !== pin.hostname)
      return callback(new Error("Unexpected private push hostname"));
    if (options?.all)
      return callback(null, [{ address: pin.address, family: pin.family }]);
    return callback(null, pin.address, pin.family);
  }) as LookupFunction;
}
