# Monize ntfy reference client

A Node.js command-line receiver for Monize's encrypted UnifiedPush channel.
It creates its own P-256 recipient key, registers an ntfy endpoint with Monize,
polls ntfy, decrypts RFC 8291 `aes128gcm` messages and emits localized JSON to
stdout. The private key stays on the receiving machine. This is a working
reference receiver for ntfy, not an Android app or a D-Bus distributor connector.
It requires a running process; it cannot wake a sleeping phone.

## Run

Use Node.js 24 on Linux/macOS and install the backend dependencies (`npm ci`
in `backend`). The client does not require the backend process or PostgreSQL on
the receiving machine. Paths below are relative to `backend`.

Create a private directory and initialize exactly once:

```sh
mkdir -m 700 "$HOME/monize-push"
node scripts/unifiedpush-client/cli.cjs init "$HOME/monize-push/device.json" https://monize.example https://ntfy.example
```

Replace both origins with your own. HTTPS is mandatory. Origin subpaths,
embedded credentials, query strings and redirects are refused. The ntfy server
must allow reading and publishing to a random capability topic without extra
HTTP authentication; servers requiring an ntfy access token are not supported
by this first client. For a private distributor, the Monize operator must set
`UNIFIEDPUSH_PRIVATE_ENDPOINTS` as described in notification spec Section 15.1.
The receiving machine must resolve/reach the same distributor and trust its
HTTPS certificate. The backend pins its own connection to the configured IP.

For registration, sign into your Monize account normally, including MFA/SSO if
configured. In your browser's developer tools, copy the current `auth_token`
and `csrf_token` cookie values into a **local, mode-0600** JSON file:

```json
{"authToken":"YOUR_CURRENT_AUTH_TOKEN","csrfToken":"YOUR_CURRENT_CSRF_TOKEN"}
```

Create that file inside the private directory with permissions 0600 before
entering values. These are account credentials: do not commit, paste into
commands, send to a distributor or share them. This reference client's manual
session handoff avoids adding a new login or pairing endpoint. It does not
renew the session. Expired cookies require a new handoff for management
commands. Cookie values must come from the same login. PATs are not supported
by these JWT-authenticated routes.

```sh
node scripts/unifiedpush-client/cli.cjs register "$HOME/monize-push/device.json" "$HOME/monize-push/session.json"
node scripts/unifiedpush-client/cli.cjs listen "$HOME/monize-push/device.json"
```

Registration creates the device named `Monize ntfy CLI` with the `unifiedpush`
transport. Enable the UnifiedPush column for the desired notification
categories in Monize settings. The client never changes category preferences.
Use the existing test-notification button to exercise reception.

The session file can be deleted after registration. Listening uses only the
ntfy topic and local recipient keys, so session expiry does not stop reception.
Keep `device.json` private: it contains the recipient private key, auth secret
and capability topic. A second `init` refuses to overwrite it. Restart `listen`
with the same file to resume from the last recorded message ID.

Each stdout line contains `title`, `body` and a validated Monize `target` URL.
Copy follows the recipient's language as composed by the server. The client
never runs commands from a message, opens a URL automatically, fetches images,
or executes the Stop action. It is a JSON receiver, not a desktop banner UI.
For reminder management, open the Monize app. Integration into a desktop shell
or native mobile UI is a separate consumer of this receiver.

Stop the listener with Ctrl-C before removing the device:

```sh
node scripts/unifiedpush-client/cli.cjs remove "$HOME/monize-push/device.json" "$HOME/monize-push/session.json"
```

Removal needs fresh session cookies. It removes the Monize subscription, not
ntfy's already-cached encrypted messages. After successful removal, delete the
local key and session files if you no longer need this device. Removing the row
in Monize settings also stops future sends. If the VAPID identity rotates,
repeat `register` with the existing device state and a current session.

## Delivery and failure behavior

Polling normally happens every five seconds. Network failures back off to at
most sixty seconds; each request has a fifteen-second deadline. Checkpoints
are replaced atomically after output succeeds. A process crash between output
and checkpoint can repeat a message. Catch-up is limited by the ntfy server's
cache retention; this client cannot promise delivery while offline indefinitely.
A cached response over 1 MiB or flagged as truncated is refused rather than
reported as fully processed. Per-message ciphertext is limited to 4096 bytes.
Unauthentic ciphertext is skipped so it cannot block later messages.

Commands hold an exclusive `<state>.lock` file. After an unclean process kill,
verify no client is running before removing that lock. Do not run commands
against the same state from multiple machines. The state directory must be
owned by you and inaccessible to other users. Reads refuse symlinks, hardlinks
and group/world-readable private files.

Stderr contains machine status codes, never raw HTTP errors, tokens or message
bodies. `RECEIVE_RETRY` means check connectivity, distributor permissions and
cache limits. `CLIENT_FAILED_READ_README` means check arguments, file permissions,
lock state and session validity. Normal decrypted output on stdout is sensitive;
do not direct it into shared service logs.

## Verification

```sh
npm run push:client:test
npm run push:tls:test
```

Tests use the real installed `web-push` encryptor and `http_ece` decryptor, and
mock only the Monize and ntfy HTTP boundaries. They check registration payloads,
CSRF credentials, receiver key ownership, malformed messages, navigation,
checkpointing and private storage. CI runs them. No live distributor or signed-in
Monize account was used in the development workspace; a deployment smoke test
still needs the registration/listen/test-button sequence above.

The separate TLS suite requires OpenSSL and permission to bind a loopback TCP
port. It uses the production pinned lookup helper with a local fixture, sends
real encrypted Web Push over HTTPS, decrypts it with this receiver, and checks
certificate trust and hostname rejection. Its temporary key/certificate are
removed afterwards. It does not relax the production rule rejecting loopback
pins, and does not need a live distributor or Monize account.

Protocol references: [ntfy UnifiedPush publishing](https://docs.ntfy.sh/publish/#unifiedpush),
[ntfy JSON subscription API](https://docs.ntfy.sh/subscribe/api/),
[RFC 8291](https://www.rfc-editor.org/rfc/rfc8291.html).
