import { timingSafeEqual } from "node:crypto";

/** Compare sensitive SimpleFIN strings without a content-dependent early exit. */
export function simplefinEqual(left: string, right: string): boolean {
  const a = Buffer.from(left, "utf8");
  const b = Buffer.from(right, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}
