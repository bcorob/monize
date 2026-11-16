/**
 * What the consent page shows as the destination of an authorization: the
 * origin (scheme, host and a non-default port) of the request's redirect_uri.
 *
 * The host comes from the WHATWG URL parser, so an internationalised domain is
 * shown in its ASCII (punycode) form and cannot pass for a look-alike Latin
 * name. A native-app redirect with a custom scheme has no web origin (`origin`
 * is the string "null"), so it is shown as `scheme://host`, or as the bare
 * scheme when it has no host. Returns null when there is nothing parseable to
 * show; the page then warns instead of naming a destination.
 */
export function describeRedirectTarget(
  redirectUri: string | null | undefined,
): string | null {
  const url = parse(redirectUri);
  if (!url) return null;
  if (url.origin && url.origin !== "null") return url.origin;
  return url.host ? `${url.protocol}//${url.host}` : url.protocol;
}

/** Lower-cased hostname of a URL, or null when it has none or does not parse. */
export function hostOf(value: string | null | undefined): string | null {
  const url = parse(value);
  return url?.hostname ? url.hostname.toLowerCase() : null;
}

function parse(value: string | null | undefined): URL | null {
  if (typeof value !== "string" || value.trim() === "") return null;
  try {
    return new URL(value);
  } catch {
    return null;
  }
}
