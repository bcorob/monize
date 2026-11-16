"use strict";
const { createECDH, randomBytes } = require("node:crypto");
const ece = require("http_ece");

function fail(code) {
  throw new Error(code);
}
function origin(value) {
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/"
  )
    fail("HTTPS_ORIGIN_REQUIRED");
  return url.origin;
}
function createState(monize, distributor) {
  const key = createECDH("prime256v1");
  key.generateKeys();
  return {
    version: 1,
    monize: origin(monize),
    distributor: origin(distributor),
    topic: `up${randomBytes(24).toString("hex")}`,
    privateKey: key.getPrivateKey().toString("base64url"),
    p256dh: key.getPublicKey().toString("base64url"),
    auth: randomBytes(16).toString("base64url"),
    since: String(Math.floor(Date.now() / 1000)),
    deviceId: null,
  };
}
function validateState(s) {
  if (!s || s.version !== 1 || !/^up[a-f0-9]{48}$/.test(s.topic))
    fail("INVALID_STATE");
  origin(s.monize);
  origin(s.distributor);
  const key = createECDH("prime256v1");
  key.setPrivateKey(Buffer.from(s.privateKey, "base64url"));
  if (
    key.getPublicKey().toString("base64url") !== s.p256dh ||
    Buffer.from(s.auth, "base64url").length !== 16 ||
    !/^[a-zA-Z0-9]{1,100}$/.test(s.since)
  )
    fail("INVALID_STATE");
  if (s.deviceId !== null && !/^[a-f0-9-]{36}$/.test(s.deviceId))
    fail("INVALID_STATE");
  return s;
}
async function boundedText(response, max = 65536) {
  if (!response.body) fail("EMPTY_RESPONSE");
  const reader = response.body.getReader();
  const parts = [];
  let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > max) fail("RESPONSE_TOO_LARGE");
      parts.push(Buffer.from(value));
    }
    return Buffer.concat(parts).toString("utf8");
  } finally {
    await reader.cancel();
  }
}
function credentials(c) {
  if (
    !c ||
    !/^[A-Za-z0-9_.-]{20,8192}$/.test(c.authToken) ||
    !/^[A-Za-z0-9_.:-]{16,2048}$/.test(c.csrfToken)
  )
    fail("INVALID_SESSION");
  return {
    Cookie: `auth_token=${c.authToken}; csrf_token=${c.csrfToken}`,
    "x-csrf-token": c.csrfToken,
  };
}
async function api(
  state,
  session,
  path,
  method = "GET",
  body,
  fetcher = fetch,
) {
  // Credentials go only to the explicitly configured Monize origin. Never follow redirects.
  const res = await fetcher(`${state.monize}/api/v1/push/${path}`, {
    method,
    headers: { ...credentials(session), "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    redirect: "error",
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) {
    await res.body?.cancel();
    fail(`MONIZE_HTTP_${res.status}`);
  }
  return res.status === 204 ? null : JSON.parse(await boundedText(res));
}
async function register(state, session, fetcher = fetch) {
  validateState(state);
  const config = await api(state, session, "config", "GET", undefined, fetcher);
  if (!config.enabled || typeof config.publicKey !== "string")
    fail("PUSH_UNAVAILABLE");
  const device = await api(
    state,
    session,
    "subscriptions",
    "POST",
    {
      endpoint: `${state.distributor}/${state.topic}?up=1`,
      p256dh: state.p256dh,
      auth: state.auth,
      applicationServerKey: config.publicKey,
      transport: "unifiedpush",
      deviceName: "Monize ntfy CLI",
    },
    fetcher,
  );
  return validateState({ ...state, deviceId: device.id });
}
function decryptEvent(state, event) {
  if (event.event !== "message") return null;
  if (
    event.topic !== state.topic ||
    typeof event.message !== "string" ||
    event.message.length > 5500
  )
    fail("INVALID_MESSAGE");
  // ntfy up=1 marks binary bodies as base64. Never trust ntfy title/body metadata.
  const bytes =
    event.encoding === "base64"
      ? Buffer.from(event.message, "base64")
      : Buffer.from(event.message, "utf8");
  if (
    bytes.length < 103 ||
    bytes.length > 4096 ||
    bytes[20] !== 65 ||
    bytes[21] !== 4 ||
    bytes.readUInt32BE(16) < 18
  )
    fail("INVALID_MESSAGE");
  const key = createECDH("prime256v1");
  key.setPrivateKey(Buffer.from(state.privateKey, "base64url"));
  const clear = ece.decrypt(bytes, {
    version: "aes128gcm",
    privateKey: key,
    authSecret: state.auth,
  });
  const payload = JSON.parse(clear.toString("utf8"));
  if (
    !payload ||
    typeof payload.title !== "string" ||
    typeof payload.body !== "string" ||
    payload.title.length > 300 ||
    payload.body.length > 300
  )
    fail("INVALID_PAYLOAD");
  // JSON output only: no shell execution, browser launch, image fetch or Stop mutation.
  const target =
    typeof payload.target === "string" &&
    /^\/(?!\/)/.test(payload.target) &&
    !/[\\\x00-\x20]/.test(payload.target)
      ? new URL(payload.target, state.monize)
      : new URL("/", state.monize);
  return {
    title: payload.title,
    body: payload.body,
    target: target.origin === state.monize ? target.href : `${state.monize}/`,
  };
}
async function poll(state, receive, checkpoint, fetcher = fetch) {
  validateState(state);
  const res = await fetcher(
    `${state.distributor}/${state.topic}/json?poll=1&since=${encodeURIComponent(state.since)}`,
    {
      redirect: "error",
      signal: AbortSignal.timeout(15000),
    },
  );
  if (!res.ok) {
    await res.body?.cancel();
    fail(`NTFY_HTTP_${res.status}`);
  }
  if (res.headers.get("x-messages-truncated") === "1") {
    await res.body?.cancel();
    fail("NTFY_CACHE_TRUNCATED");
  }
  // At most 1 MiB per poll. Each encrypted message is independently bounded.
  const text = await boundedText(res, 1024 * 1024);
  let current = state;
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    if (line.length > 12000) fail("INVALID_MESSAGE");
    const event = JSON.parse(line);
    if (event.event !== "message") continue;
    if (typeof event.id !== "string" || !/^[a-zA-Z0-9]{1,100}$/.test(event.id))
      fail("INVALID_MESSAGE_ID");
    let payload;
    try {
      payload = decryptEvent(state, event);
    } catch {
      payload = null;
    }
    // A poisoned relay message must not block later legitimate messages.
    if (payload) await receive(payload);
    current = { ...current, since: event.id };
    await checkpoint(current);
  }
  return current;
}
module.exports = {
  createState,
  validateState,
  register,
  decryptEvent,
  poll,
  api,
  origin,
};
