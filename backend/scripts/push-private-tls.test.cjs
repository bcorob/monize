"use strict";
require("ts-node/register/transpile-only");
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const https = require("node:https");
const { once } = require("node:events");
const { mkdtempSync, readFileSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { execFileSync } = require("node:child_process");
const webpush = require("web-push");
const {
  pinnedPushLookup,
  privatePushEndpoints,
} = require("../src/push/unifiedpush-private-endpoints.ts");
const { createState, decryptEvent } = require("./unifiedpush-client/core.cjs");

// Exercise real TLS over a loopback fixture without granting production
// configuration a loopback exception (asserted separately below).
let directory, server, certificate, port;
const received = [];
const recipient = createState("https://monize.example", "https://ntfy.example");
const vapid = webpush.generateVAPIDKeys();
const payload = {
  title: "Test TLS",
  body: "Wiadomość zaszyfrowana",
  target: "/settings",
};
before(async () => {
  directory = mkdtempSync(join(tmpdir(), "monize-push-tls-"));
  const keyPath = join(directory, "key.pem");
  const certPath = join(directory, "cert.pem");
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      keyPath,
      "-out",
      certPath,
      "-days",
      "1",
      "-subj",
      "/CN=ntfy.test.invalid",
      "-addext",
      "subjectAltName=DNS:ntfy.test.invalid",
    ],
    { stdio: "ignore", timeout: 15000 },
  );
  certificate = readFileSync(certPath);
  server = https.createServer(
    { key: readFileSync(keyPath), cert: certificate },
    async (req, res) => {
      const parts = [];
      for await (const part of req) parts.push(part);
      received.push({
        bytes: Buffer.concat(parts),
        hostname: req.headers.host,
        servername: req.socket.servername,
        encoding: req.headers["content-encoding"],
      });
      res.writeHead(201);
      res.end();
    },
  );
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  port = server.address().port;
});
after(async () => {
  if (server?.listening) {
    server.closeAllConnections();
    await new Promise((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
  if (directory) rmSync(directory, { recursive: true, force: true });
});
async function deliver(hostname, trusted) {
  const agent = new https.Agent({
    keepAlive: false,
    lookup: pinnedPushLookup({ hostname, address: "127.0.0.1", family: 4 }),
    ...(trusted ? { ca: certificate } : {}),
  });
  try {
    return await webpush.sendNotification(
      {
        endpoint: `https://${hostname}:${port}/topic?up=1`,
        keys: { p256dh: recipient.p256dh, auth: recipient.auth },
      },
      JSON.stringify(payload),
      {
        agent,
        timeout: 3000,
        vapidDetails: { subject: "mailto:test@example.com", ...vapid },
      },
    );
  } finally {
    agent.destroy();
  }
}
test("real HTTPS delivery preserves SNI and carries decryptable Web Push", async () => {
  const response = await deliver("ntfy.test.invalid", true);
  assert.equal(response.statusCode, 201);
  const wire = received.at(-1);
  assert.equal(wire.servername, "ntfy.test.invalid");
  assert.equal(wire.hostname, `ntfy.test.invalid:${port}`);
  assert.equal(wire.encoding, "aes128gcm");
  assert.deepEqual(
    decryptEvent(recipient, {
      event: "message",
      topic: recipient.topic,
      encoding: "base64",
      message: wire.bytes.toString("base64"),
    }),
    { ...payload, target: "https://monize.example/settings" },
  );
});
test("pinning an IP does not bypass certificate hostname validation", async () => {
  const before = received.length;
  await assert.rejects(
    deliver("wrong.test.invalid", true),
    (error) => error.code === "ERR_TLS_CERT_ALTNAME_INVALID",
  );
  assert.equal(received.length, before);
});
test("pinning an IP does not trust a self-signed certificate automatically", async () => {
  const before = received.length;
  await assert.rejects(deliver("ntfy.test.invalid", false), (error) =>
    ["DEPTH_ZERO_SELF_SIGNED_CERT", "SELF_SIGNED_CERT_IN_CHAIN"].includes(
      error.code,
    ),
  );
  assert.equal(received.length, before);
});
test("the local fixture does not make loopback configurable in production", () => {
  assert.throws(() =>
    privatePushEndpoints('{"https://ntfy.test.invalid":"127.0.0.1"}'),
  );
});
