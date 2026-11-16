"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const webpush = require("web-push");
const {
  createState,
  register,
  decryptEvent,
  poll,
  api,
} = require("./core.cjs");
const {
  mkdtempSync,
  chmodSync,
  symlinkSync,
  rmSync,
  readFileSync,
} = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { readPrivate, writePrivate, locked } = require("./storage.cjs");
const state = () =>
  createState("https://monize.example", "https://ntfy.example");
const session = {
  authToken: "a".repeat(40),
  csrfToken: "b".repeat(32) + ":" + "c".repeat(64),
};
const json = (value) =>
  new Response(JSON.stringify(value), {
    headers: { "Content-Type": "application/json" },
  });
function event(
  s,
  payload = {
    title: "Zmiana ceny",
    body: "Otwórz instrument",
    target: "/securities/123",
  },
) {
  const encrypted = webpush.encrypt(
    s.p256dh,
    s.auth,
    Buffer.from(JSON.stringify(payload)),
    "aes128gcm",
  );
  return {
    event: "message",
    topic: s.topic,
    id: "event123",
    encoding: "base64",
    message: encrypted.cipherText.toString("base64"),
  };
}
test("registers generated recipient keys and UnifiedPush endpoint; private key stays local", async () => {
  const s = state(),
    calls = [];
  const result = await register(s, session, async (url, options) => {
    calls.push({ url, options });
    return calls.length === 1
      ? json({
          enabled: true,
          publicKey: webpush.generateVAPIDKeys().publicKey,
        })
      : json({ id: "11111111-1111-4111-8111-111111111111" });
  });
  assert.ok(result.deviceId);
  const posted = JSON.parse(calls[1].options.body);
  assert.equal(posted.transport, "unifiedpush");
  assert.equal(posted.endpoint, `${s.distributor}/${s.topic}?up=1`);
  assert.equal(posted.p256dh, s.p256dh);
  assert.equal(posted.auth, s.auth);
  assert.equal(JSON.stringify(calls).includes(s.privateKey), false);
  for (const c of calls) {
    assert.ok(c.url.startsWith(s.monize + "/"));
    assert.equal(c.options.redirect, "error");
    assert.equal(c.options.headers["x-csrf-token"], session.csrfToken);
  }
});
test("decrypts real web-push aes128gcm output and preserves localized copy", () => {
  const s = state();
  assert.deepEqual(decryptEvent(s, event(s)), {
    title: "Zmiana ceny",
    body: "Otwórz instrument",
    target: "https://monize.example/securities/123",
  });
});
test("rejects ciphertext tampering, wrong device and plaintext relay messages", () => {
  const s = state(),
    e = event(s),
    bytes = Buffer.from(e.message, "base64");
  bytes[bytes.length - 1] ^= 1;
  assert.throws(() =>
    decryptEvent(s, { ...e, message: bytes.toString("base64") }),
  );
  assert.throws(() => decryptEvent({ ...state(), topic: s.topic }, e));
  assert.throws(() =>
    decryptEvent(s, { ...e, encoding: undefined, message: "plaintext" }),
  );
});
test("replaces unsafe navigation and never forwards image/action metadata", () => {
  const s = state();
  for (const target of [
    "//evil.example/x",
    "https://evil.example",
    "/\\evil.example",
    "/\nevil.example",
  ]) {
    const p = decryptEvent(
      s,
      event(s, {
        title: "T",
        body: "B",
        target,
        image: "https://evil.example",
        actions: [{ action: "stop-reminder" }],
      }),
    );
    assert.equal(p.target, s.monize + "/");
    assert.equal(p.image, undefined);
    assert.equal(p.actions, undefined);
  }
});
test("polls without Monize credentials and checkpoints past poisoned messages", async () => {
  const s = state(),
    received = [],
    checkpoints = [];
  const good = event(s);
  const bad = { ...good, id: "bad123", message: "invalid" };
  const updated = await poll(
    s,
    async (p) => received.push(p),
    async (p) => checkpoints.push(p.since),
    async (url, options) => {
      assert.ok(url.startsWith(s.distributor + "/"));
      assert.equal(options.headers, undefined);
      assert.equal(options.redirect, "error");
      return new Response([bad, good].map(JSON.stringify).join("\n"));
    },
  );
  assert.equal(received.length, 1);
  assert.deepEqual(checkpoints, ["bad123", "event123"]);
  assert.equal(updated.since, "event123");
});
test("refuses partial relay cache and oversized response", async () => {
  const s = state();
  await assert.rejects(
    poll(
      s,
      () => {},
      () => {},
      async () =>
        new Response("", { headers: { "X-Messages-Truncated": "1" } }),
    ),
    /NTFY_CACHE_TRUNCATED/,
  );
  await assert.rejects(
    poll(
      s,
      () => {},
      () => {},
      async () => new Response("x".repeat(1024 * 1024 + 1)),
    ),
    /RESPONSE_TOO_LARGE/,
  );
});
test("requires explicit HTTPS origins without userinfo, paths or queries", () => {
  for (const bad of [
    "http://example.test",
    "https://u:p@example.test",
    "https://example.test/path",
    "https://example.test?q=1",
  ])
    assert.throws(() => createState(bad, "https://ntfy.example"));
});
test("does not expose a response body on authentication failure", async () => {
  await assert.rejects(
    api(
      state(),
      session,
      "config",
      "GET",
      undefined,
      async () => new Response("sensitive secret", { status: 401 }),
    ),
    { message: "MONIZE_HTTP_401" },
  );
});
test("stores keys privately, refuses overwrite/symlinks and releases command lock", async () => {
  const dir = mkdtempSync(join(tmpdir(), "monize-up-")),
    path = join(dir, "state.json");
  try {
    const s = state();
    writePrivate(path, s, true);
    assert.deepEqual(readPrivate(path), s);
    assert.throws(() => writePrivate(path, state(), true));
    const link = join(dir, "link.json");
    symlinkSync(path, link);
    assert.throws(() => readPrivate(link));
    chmodSync(path, 0o644);
    assert.throws(() => readPrivate(path), /PRIVATE_FILE_REQUIRED/);
    chmodSync(path, 0o600);
    await locked(path, async () => {
      await assert.rejects(locked(path, async () => {}));
    });
    await locked(path, async () =>
      writePrivate(path, { ...s, since: "newid" }),
    );
    assert.equal(readPrivate(path).since, "newid");
    assert.ok(readFileSync(path, "utf8").includes(s.privateKey));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("registration-to-reception harness uses the exact registered recipient keys", async () => {
  const initial = state();
  let posted;
  const registered = await register(initial, session, async (url, opts) => {
    if (url.endsWith("/config"))
      return json({
        enabled: true,
        publicKey: webpush.generateVAPIDKeys().publicKey,
      });
    posted = JSON.parse(opts.body);
    return json({ id: "22222222-2222-4222-8222-222222222222" });
  });
  const wire = webpush.encrypt(
    posted.p256dh,
    posted.auth,
    JSON.stringify({ title: "Test", body: "Dostarczono", target: "/settings" }),
    "aes128gcm",
  ).cipherText;
  const received = [];
  const updated = await poll(
    registered,
    (p) => received.push(p),
    () => {},
    async () =>
      new Response(
        JSON.stringify({
          id: "fullpath1",
          event: "message",
          topic: registered.topic,
          encoding: "base64",
          message: wire.toString("base64"),
        }),
      ),
  );
  assert.deepEqual(received, [
    {
      title: "Test",
      body: "Dostarczono",
      target: "https://monize.example/settings",
    },
  ]);
  assert.equal(updated.since, "fullpath1");
});
