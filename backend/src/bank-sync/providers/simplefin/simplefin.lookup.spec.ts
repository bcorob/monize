import type { LookupAddress, LookupOptions } from "node:dns";
import type { ResolveAll } from "../../../ai/providers/provider-egress";
import { simplefinLookupVia } from "./simplefin.lookup";

function lookup(addresses: string[]) {
  const resolver: ResolveAll = (_host, _options, callback) =>
    callback(
      null,
      addresses.map((address) => ({
        address,
        family: address.includes(":") ? 6 : 4,
      })),
    );
  const guarded = simplefinLookupVia(resolver);
  return new Promise<LookupAddress[]>((resolve, reject) => {
    // Node's socket requests all answers when automatic family selection is enabled.
    const call = guarded as unknown as (
      host: string,
      options: LookupOptions,
      callback: (error: Error | null, addresses: LookupAddress[]) => void,
    ) => void;
    call("bridge.simplefin.org", { all: true }, (error, result) =>
      error ? reject(error) : resolve(result),
    );
  });
}

describe("SimpleFIN socket DNS policy", () => {
  it.each([
    "127.0.0.1",
    "10.0.0.1",
    "172.16.0.1",
    "192.168.0.1",
    "169.254.169.254",
    "0.0.0.0",
    "100.64.0.1",
    "192.0.0.1",
    "192.0.2.1",
    "198.18.0.1",
    "198.51.100.1",
    "203.0.113.1",
    "224.0.0.1",
    "255.255.255.255",
    "::1",
    "::",
    "::ffff:127.0.0.1",
    "fc00::1",
    "fe80::1",
    "ff00::1",
    "2001:db8::1",
    "2002:7f00:1::",
    "64:ff9b::a00:1",
    "3fff::1",
  ])(
    "refuses a mixed public/reserved answer containing %s",
    async (address) => {
      await expect(lookup(["1.1.1.1", address])).rejects.toBeInstanceOf(Error);
    },
  );

  it("returns the validated addresses directly to the socket lookup caller", async () => {
    await expect(lookup(["1.1.1.1", "2606:4700:4700::1111"])).resolves.toEqual([
      { address: "1.1.1.1", family: 4 },
      { address: "2606:4700:4700::1111", family: 6 },
    ]);
  });

  it("refuses an empty answer", async () => {
    await expect(lookup([])).rejects.toBeInstanceOf(Error);
  });
});
