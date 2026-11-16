import { simplefinAccessRequest } from "./simplefin.urls";

/** Free-text provider fields cannot echo a credential back to the UI or ledger. */
export function simplefinRedactor(
  accessUrl: string,
): (value: string | null) => string | null {
  const request = simplefinAccessRequest(accessUrl);
  const userinfo = Buffer.from(
    request.authorization.slice(6),
    "base64",
  ).toString("utf8");
  const separator = userinfo.indexOf(":");
  const secrets = [
    accessUrl,
    request.authorization,
    userinfo,
    userinfo.slice(0, separator),
    userinfo.slice(separator + 1),
  ].filter(Boolean);
  return (value) => {
    if (value === null) return null;
    for (const secret of secrets)
      value = value.replaceAll(secret, "[redacted]");
    return value;
  };
}
