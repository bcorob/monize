import { simplefinEqual } from "./simplefin-equal";

const BRIDGE_HOSTS = new Set([
  "bridge.simplefin.org",
  "beta-bridge.simplefin.org",
]);

/** Pure validation only. The HTTP transport must additionally pin public DNS results. */
function bridgeUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Invalid SimpleFIN URL");
  }
  if (
    url.protocol !== "https:" ||
    !BRIDGE_HOSTS.has(url.hostname) ||
    url.port !== "" ||
    url.hash ||
    url.search ||
    url.href.length > 8192 ||
    Array.from(value).some(
      (char) => char.charCodeAt(0) <= 32 || char.charCodeAt(0) === 127,
    )
  ) {
    throw new Error("Invalid SimpleFIN URL");
  }
  return url;
}

/** Decode only canonical Base64, rejecting arbitrary or credential-bearing claim destinations. */
export function simplefinClaimUrl(setupToken: string): URL {
  const token = setupToken.trim();
  if (
    token.length === 0 ||
    token.length > 16384 ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(token) ||
    token.length % 4 !== 0
  ) {
    throw new Error("Invalid SimpleFIN setup token");
  }
  const bytes = Buffer.from(token, "base64");
  if (!simplefinEqual(bytes.toString("base64"), token))
    throw new Error("Invalid SimpleFIN setup token");
  const value = bytes.toString("utf8");
  if (!Buffer.from(value, "utf8").equals(bytes))
    throw new Error("Invalid SimpleFIN setup token");
  const url = bridgeUrl(value);
  if (
    url.username ||
    url.password ||
    !/^\/simplefin\/claim\/[A-Za-z0-9_-]+$/.test(url.pathname)
  ) {
    throw new Error("Invalid SimpleFIN claim URL");
  }
  return url;
}

/** Keep userinfo out of the fetch URL; never log the returned header or original input. */
export function simplefinAccessRequest(accessUrl: string): {
  root: URL;
  authorization: string;
} {
  const url = bridgeUrl(accessUrl);
  if (
    !/^\/simplefin(?:\/[A-Za-z0-9_-]+)*\/?$/.test(url.pathname) ||
    url.pathname.startsWith("/simplefin/claim") ||
    !url.username ||
    !url.password
  ) {
    throw new Error("Invalid SimpleFIN access URL");
  }
  let username: string;
  let password: string;
  try {
    username = decodeURIComponent(url.username);
    password = decodeURIComponent(url.password);
  } catch {
    throw new Error("Invalid SimpleFIN access credentials");
  }
  if (
    username.includes(":") ||
    Array.from(username + password).some(
      (char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127,
    )
  ) {
    throw new Error("Invalid SimpleFIN access credentials");
  }
  url.username = "";
  url.password = "";
  url.pathname = url.pathname.replace(/\/$/, "");
  return {
    root: url,
    authorization: `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`,
  };
}
