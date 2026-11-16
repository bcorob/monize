import { Request } from "express";

/**
 * The address a request came from, as this deployment can best determine it.
 *
 * `main.ts` sets `trust proxy` to 1, so `req.ip` is the last hop's
 * `X-Forwarded-For` entry behind the one reverse proxy this stack ships with
 * (Docker/nginx) and the socket address otherwise; `req.socket.remoteAddress`
 * is the fallback for a request that reached Express through neither (a test
 * double, a raw socket).
 *
 * The `::ffff:` prefix is stripped because a dual-stack Node listener reports
 * every IPv4 client as an IPv4-mapped IPv6 address, so the same machine is
 * `203.0.113.4` on one deployment and `::ffff:203.0.113.4` on another -- two
 * spellings of one address, stored in one column, compared by a human.
 *
 * `null` rather than a placeholder when nothing resolves: an address this
 * server could not determine is unknown, and a consumer has to be able to say
 * so rather than record a string nobody was at.
 */
export function clientIpOf(req: Request): string | null {
  const raw = req.ip || req.socket?.remoteAddress;
  if (!raw) return null;
  const address = raw.replace(/^::ffff:/, "").trim();
  return address.length > 0 ? address : null;
}
