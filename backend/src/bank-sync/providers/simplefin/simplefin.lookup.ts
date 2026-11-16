import * as dns from "node:dns";
import { isIP } from "node:net";
import {
  publicOnlyLookupVia,
  type ResolveAll,
} from "../../../ai/providers/provider-egress";

/** Bridge only needs ordinary public unicast, never transition or reserved space. */
function reservedAddress(address: string): boolean {
  if (isIP(address) === 4) {
    const [a, b, c] = address.split(".").map(Number);
    return (
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 192 && b === 0 && (c === 0 || c === 2)) ||
      (a === 192 && b === 88 && c === 99) ||
      (a === 198 && (b === 18 || b === 19)) ||
      (a === 198 && b === 51 && c === 100) ||
      (a === 203 && b === 0 && c === 113) ||
      a >= 224
    );
  }
  if (isIP(address) === 6) {
    const [first, second] = address
      .toLowerCase()
      .split(":")
      .map((part) => parseInt(part || "0", 16));
    return (
      first < 0x2000 ||
      first > 0x3fff ||
      first === 0x2002 ||
      (first === 0x2001 && (second <= 0x1ff || second === 0xdb8)) ||
      (first === 0x3fff && second <= 0xfff)
    );
  }
  return true;
}

/** Reuse the socket-level private-address guard and additionally refuse reserved answers. */
export function simplefinLookupVia(resolve: ResolveAll) {
  return publicOnlyLookupVia((host, options, callback) =>
    resolve(host, options, (error, addresses) => {
      if (error) return callback(error, []);
      if (addresses.some(({ address }) => reservedAddress(address))) {
        return callback(new Error("SimpleFIN destination refused"), []);
      }
      callback(null, addresses);
    }),
  );
}

export const simplefinLookup = simplefinLookupVia(
  (hostname, options, callback) =>
    dns.lookup(hostname, { ...options, all: true }, (error, addresses) =>
      callback(error, addresses ?? []),
    ),
);
