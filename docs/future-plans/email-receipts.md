# Email receipts: order-confirmation emails enrich bank transactions

Companion files: [`email-receipts-tasks.md`](./email-receipts-tasks.md) (the
task list) and `docs/specs/email-receipt-matching.md` (the
matching and proposal arithmetic: truth tables, numerical examples, missing-data
policy, test matrix).

Status: **on `main`** since PR #1497 (2026-10-09), with #1756, #1770 and #1771
after it; `backend/src/email-receipts/`. Open: E1 (the E2E test against a
GreenMail container, not yet in `docker-compose.e2e.yml`) and the open questions
in section 12, which the maintainer decides.

## 1. Goal

A bank transaction says how much and when, not what was bought. The order
confirmation email says what. The user forwards (or filters) order
confirmations to a dedicated mailbox; Monize reads that mailbox over IMAP,
read-only, finds the transaction each email pays for, and proposes an
enrichment: a description, a split by line item with a category per line, a
payee. The user approves the proposal in the review queue. Nothing is written to
the ledger without an approval, except by an opt-in auto-apply that section 7
bounds.

"AI is a compiler": a per-merchant parser is written once (by the user, or
drafted by the user's AI provider from one sample email and approved by the
user) and then runs deterministically. The AI is not called per email unless the
user chose that.

A brokerage's trade-confirmation email is the other half of the same idea (it
has no bank transaction to enrich; it IS the missing transaction):
[`email-receipt-trades.md`](../specs/email-receipt-trades.md).

Out of scope for this branch: receipt photos and OCR (a vision pass over an
image attachment), more than one mailbox per user, POP3, and attaching the
email's PDF parts to the transaction. Section 11 records them.

## 2. What exists, and what this composes

| Piece | Where | Used for |
|---|---|---|
| Glob with named captures | `backend/src/transaction-rules/rule-glob-capture.ts` | Every extraction pattern of a parser, applied to one line at a time |
| AI review queue | `backend/src/ai-review/` | The processing queue: a proposal is a signed `PendingAiAction`, approved through `/ai/actions/confirm`, marked applied in the write's own transaction |
| Proposal validation and card | `AiReviewWorkService.submit` / `buildCard` | Exact split sum, category resolution, transfer refusal, the confirmation card |
| AI providers | `AiService.complete` | Drafting a parser from a sample; proposing an enrichment for an email no parser reads |
| Secret encryption | `EncryptionService` | The IMAP password (AES-256-GCM) |
| Egress policy | `ai/providers/provider-egress.ts`, `ai/validators/safe-url.validator.ts`, `ai/validators/private-base-url-allowlist.ts` | The IMAP host reaches only public addresses unless the owner is an admin or the operator allows it |
| Per-user lease | `JobClaimService.claimLease` | One poll per mailbox at a time across replicas |
| Payee lookup | `PayeesService.resolveByName` | The parser's payee, and the proposal's payee name |

**Why the rules engine is not the parser.** The rule condition tree and its
facts are typed to a transaction row, and the glob matcher refuses text longer
than 500 characters, finds one match per pattern and has no repetition. An
email body is thousands of characters and a receipt has N line items. So the
parser is its own small language, but every pattern in it is a rule glob,
matched by `matchGlobWithCaptures` against one line of the email's text (lines
are cut to 500 characters). No regular expression is accepted anywhere, for the
same reason the rules refuse one (ReDoS, `docs/future-plans/transaction-rules.md`
section 10.5).

## 3. Product decisions

1. **One mailbox per user**, dedicated to receipts. The settings screen says the
   mailbox should hold nothing else: every message in its folder is read. The
   mailbox's `enabled` switch ("Read the mailbox automatically") means exactly
   that and nothing more: it decides whether the 15-minute cron polls the
   mailbox. It does not mean the mailbox is on or off, and "Poll now" works
   whether or not it is set. A mailbox that cannot connect (an OAuth2 mailbox
   whose token was disconnected or revoked) refuses to poll either way, with the
   reason (reconnect it) as the result.
2. **Read-only.** The folder is opened with `EXAMINE` (`readOnly: true`) and
   messages are fetched with `BODY.PEEK`. Monize never sets a flag, moves,
   deletes or appends. Progress is a UID cursor stored in Monize.
3. **TLS always.** `security` is `tls` (implicit, port 993) or `starttls`
   (port 143, upgrade required). There is no plaintext mode. The certificate is
   verified; there is no "accept any certificate" switch.
4. **First sync is bounded**: messages received in the last 30 days. After that,
   every message with a UID above the cursor, 50 per poll (operator-tunable).
5. **The review queue is the existing AI review inbox** (`/ai-reviews`). A
   receipt's proposal is a request of kind `email_receipt`. The receipts page
   (`/email-receipts`) lists every stored email with its state and the actions
   on it (link to a transaction, reprocess, recognize with AI, draft a parser with
   AI, ignore, delete). Up to 25 emails (at most five per sender, at most five senders:
   `docs/specs/email-receipt-linked-receipts.md` 10a) can be selected there and
   parsers drafted from them together.
6. **AI mode and "Recognize with AI".** AI mode is per mailbox: `off` (the poll
   never calls the AI for receipts), `on_demand` and `automatic` (the poll asks
   the AI, bounded per tick, for a matched receipt no approved parser could
   fully read, and drafts a parser for a sender domain that has none). The mode
   governs only what happens by itself. The two buttons, "Recognize with AI" and
   "Draft parser with AI", are the person's own consent and are offered whatever
   the mode: neither calls a provider from the receipts page, each queues an AI
   review request and hands the work to the assistant in the chat (or leaves it
   for an agent).

   The button **"Recognize with AI"** is the person's own consent and is offered
   whatever the mode, for an email in `no_parser`, `parse_failed`, `unmatched`,
   `ambiguous`, `review_conflict`, or `review` whose shown state is `dismissed`,
   `expired` or `request_missing` (never one with an applied request, an ignored
   or a skipped one). It confirms the email's transaction (with a way to choose
   another), or opens the transaction picker (an ambiguous email lists its
   candidates first), then queues an AI review request for that transaction and
   **opens the assistant's chat** (`/ai`) with the order email attached as a text
   file and a message already typed in the composer; the assistant claims the
   request by id (`ai_review_requests` `claim` with `requestId`) and submits its
   proposal, which appears as a confirmation card in the chat and in the review
   inbox. Without an AI provider that can answer, the request waits `pending` in
   the inbox for an agent (for example over MCP) and the inbox row says so. The
   hand-off is **staged, never sent** (INV-SHARE-002's contract): the files and
   the text land on the composer and the user presses Send; it lives in memory
   only (`lib/ai-chat-handoff.ts`, nothing in browser storage). An AI answer is
   always a proposal or a draft; it is never applied or approved on its own.

   **"The assistant can answer now"** is decided at the moment of the click, after
   the request is queued, by `assistantCanAnswerNow` (`lib/assistant-ready.ts`):
   an AI provider is configured (`GET /ai/status` `configured`) AND, when the
   user's top provider is the MCP relay (their own agent over MCP,
   `relayActive`), that agent is connected (`GET /ai/relay/status`: `listening`
   or `busy`, not `offline`). A relay that is configured but whose agent is not
   connected would fail the chat with "Your MCP relay agent is not connected", so
   it is the queued outcome. A failed read of either is "no", never "yes". Both
   buttons use the same decision.

   **"Draft parser with AI"** is the same hand-off for a parser instead of a
   proposal, from one to 25 emails of up to five senders (five per sender): `POST /email-receipt-parsers/draft-with-ai`
   queues a `pending` request of kind `email_parser_draft` (fixed instruction
   `RECEIPT_PARSER_DRAFT_INSTRUCTION`; no provider call), then the chat opens with
   each email attached as a text file (its id in the header) and the message
   "Build an email receipt parser for these N order emails from DOMAIN. Claim AI
   review request ID, test your parser on every attached email with the
   email_receipt_parsers tool, fix it until each one reads completely, then save
   it as a draft for request ID." staged, or the request waits in the review
   inbox. The assistant claims the request by id, tests and saves a **draft**
   (`email_receipt_parsers`, section 8); the draft reads nothing until the person
   approves it in the parser settings, which marks the request `applied`.
7. **Auto-apply** (off by default) applies a proposal without asking only when
   all of: an approved parser read the email completely, the match is by order
   number or by exact amount plus payee with a single candidate, and the
   proposal balances to the cent. It applies through the same signed card and
   the same `/ai/actions/confirm` path a person's approval uses, so what is
   applied is what the card would have shown. Everything else waits for a
   person.
8. **A receipt that matches nothing is retried** on every poll for 30 days
   after it arrived: the bank transaction usually arrives later than the email.
9. **The email is kept** (subject, sender, date, text up to 100,000 characters,
   and the HTML part up to 1,000,000 characters) until the user deletes it or
   deletes the mailbox. The raw MIME source is not stored. `body_text` is what
   every parser and prompt reads (converted from the HTML when the message has no
   text part); `body_html` is shown by the detail dialog in an
   `<iframe sandbox="" srcDoc>` whose document starts with a Content-Security-Policy
   meta (`default-src 'none'; img-src data: cid:; style-src 'unsafe-inline';
   font-src data:`) so remote images and trackers never load, with a toggle to the
   text. The server also reads it, in one streaming pass of `htmlparser2`
   (`imap/html-lines.util.ts`, the only file that imports it), for exactly two
   things: the lines of a parser whose `source` is `html` (section 5.1) and the
   email's schema.org order (decision 13). It is never searched, never sent to a
   model, and never put in the page's DOM, and the list never returns it. The
   text a prompt or an agent reads is still `body_text`.
10. **Two ways to log in**: a password (an app password for most providers) or
    OAuth2 (XOAUTH2) for Google and Microsoft 365, section 3a.
11. **Owner only.** A delegate sees neither the settings nor the receipts page,
    and the API refuses a delegate's session.
12. **A forwarded email is stored as the shop's.** The user forwards order
    confirmations from their own Gmail (or Outlook, Apple Mail, Thunderbird), so
    the mailbox's From is the user's and the Date is the forward's, a month after
    the purchase. `detectForwardedOriginal` reads the forwarded header block pasted
    into the text (English, Polish, German, French and Spanish labels; the date
    formats those clients write) and the email is stored with the ORIGINAL sender
    and subject (`from_address`, `from_domain`, `subject`), the forwarder in
    `forwarded_by`, and the day the shop sent it in `original_sent_at`. Parser
    selection reads the shop's domain, and the match window is centred on the
    **purchase date**, `original_sent_at ?? received_at` (spec section 3). It is
    done at ingestion and again on every reprocess, from the stored text, so an
    email stored before this heals on "Reprocess" (idempotent: the forwarder is
    kept once recorded). A header that cannot be read leaves the email as the
    mailbox saw it; an original date later than the day the forward arrived is
    dropped as garbled. The text is untrusted, so the block is honoured only
    when the outer From is the owner's own address (the mailbox login or the
    verified account email), and then it can only choose which approved parser
    reads the email and which days to look at: a forward never auto-applies, so
    it reaches the ledger only through a person's approval of the card, which
    names the forwarder (A26-H02).

13. **Who reads an email, in order.** (1) An approved parser selected for the
    shop's domain wins whenever it finds a `total` or a `paid`. (2) Otherwise,
    when no parser applies or the parser found neither, the schema.org `Order`
    or `Invoice` the HTML part carries as JSON-LD or microdata (the markup a
    mail client reads for its own order card) is read when it states a total
    and at least one line item (`ParsedReceipt.source` `"schema_org"`,
    `status_reason` `schema_org`; spec "Structured data"). (3) Otherwise
    `no_parser` or `parse_failed` as before. The markup is the sender's own
    claim, so it goes through the same completeness table, the same matching
    and the same review card as a parser's reading; its categories come only
    from the default category of the payee the seller's name resolves to
    (looked up, never created), and **it never auto-applies**: only an
    approved parser's complete reading can (decision 7). The AI is not part of
    this order (decision 6). A mail client that forwards a message inline
    builds a new message and usually drops the original's `<script>` and
    microdata, so the markup is found mostly in mail that reaches the mailbox as
    the shop sent it, for example through a filter that auto-forwards the
    original (Gmail then keeps the original body); the parser path, which reads
    the visible text, has no such limit.

    Archived mail (`.eml`, `.mbox`, `.zip`, Outlook `.msg`) is imported through
    the same row builder (`backend/src/email-receipts/import/`).

## 3a. OAuth2 login (Google, Microsoft 365)

Google and Microsoft 365 refuse a plain password on IMAP for most accounts, so
the mailbox can instead be connected with OAuth2 and logged in with SASL
XOAUTH2 (`imapflow` `auth: { user, accessToken }`).

- **The operator registers one OAuth client per provider** and sets
  `EMAIL_RECEIPTS_GOOGLE_CLIENT_ID` / `_CLIENT_SECRET` and
  `EMAIL_RECEIPTS_MICROSOFT_CLIENT_ID` / `_CLIENT_SECRET` / `_TENANT`
  (default `common`). A provider without a client is not offered. The redirect
  URI to register is `{PUBLIC_APP_URL}/settings/email-receipts/oauth-callback`.
- **Scopes**: Google `https://mail.google.com/ openid email` (IMAP has no
  narrower Google scope; it is a restricted scope, so an unverified client
  works only for the test users the operator lists); Microsoft
  `https://outlook.office.com/IMAP.AccessAsUser.All offline_access openid email`.
  The scope allows writing; Monize still opens the folder read-only
  (INV-RECEIPT-001 holds by the client, not by the grant).
- **Host is fixed** by the provider: `imap.gmail.com:993` and
  `outlook.office365.com:993`, TLS. The user does not type a host, port or
  password; the login name is the `email` claim of the ID token returned by the
  token endpoint.
- **Flow** (authorization code with PKCE): `POST
  /email-receipts/mailbox/oauth/start {provider}` returns the authorization URL;
  its `state` is an encrypted, expiring envelope holding the user id, the
  provider and the PKCE verifier, and its nonce is consumed once
  (`SingleUseTokenService`). The provider redirects the browser to the frontend
  callback page, which posts `code` and `state` to the authenticated `POST
  /email-receipts/mailbox/oauth/complete`. The server checks the state belongs
  to the caller, exchanges the code, and stores the refresh token encrypted.
- **Each connection** exchanges the refresh token for an access token and
  stores a rotated refresh token when the provider returns one. A refused
  refresh (`invalid_grant`: revoked, expired, password changed) is recorded as
  the mailbox's `last_error` with the instruction to reconnect, and the poll
  stops for that mailbox until the user reconnects.
- **Disconnect** deletes the stored token; the user revokes the grant at the
  provider (the settings screen links to it).

As built (`backend/src/email-receipts/oauth/`), where the implementation is more
specific than the text above:

- **`invalid_grant` deletes the stored refresh token**, not only records it: a
  conditional UPDATE keyed on the ciphertext the call read, so a concurrent
  reconnect is never overwritten. The mailbox keeps its row, settings and
  receipts, `enabled` stays as the user left it, and `listEnabledMailboxes`
  skips an OAuth2 mailbox with no token, which is how "the poll stops" holds. The
  `last_error` line is the translated reconnect sentence. `interaction_required`,
  `consent_required` and `login_required` are treated as `invalid_grant`;
  `invalid_client` (the operator's client), `unavailable` and `rejected` keep the
  token and surface as an ordinary poll failure line.
- **The IMAP host for an OAuth2 mailbox comes from the provider table on every
  connection**, never from the stored `host` column (which is written for display
  only), so an access token can only go to the provider's own server.
- **The SASL mechanism is imapflow's choice** (XOAUTH2, or OAUTHBEARER where the
  server offers it); the redaction list covers the base64 string of both.
- **A Microsoft tenant that is not `[A-Za-z0-9][A-Za-z0-9.-]{0,99}`** makes the
  Microsoft provider unavailable (warned once) instead of building an endpoint
  from it. A Microsoft refresh request repeats the scope, as that endpoint
  expects.
- **Credentials CHECK** (`ck_email_receipt_mailboxes_credentials`): a password
  mailbox has a password, no provider and no refresh token; an OAuth2 mailbox has
  a provider and no password (its refresh token may be absent: disconnected or
  revoked).
- **Routes** beyond `start` and `complete`: `GET .../oauth/providers`,
  `DELETE .../oauth` (disconnect: token deleted, `enabled` false),
  `PATCH /email-receipts/mailbox/settings` (folder, enabled, aiMode, autoApply,
  either auth method; a folder change resets the cursor). `PUT
  /email-receipts/mailbox` on an OAuth2 mailbox switches it to password login,
  requires a password and deletes the refresh token.
- **The state nonce is claimed outside any transaction of the write**, so a
  flow whose code exchange failed stays spent and the user starts again; another
  user's attempt is refused before the claim and cannot spend it.

## 4. Data model

Four changes, one migration each (`database/migrations/`), mirrored in
`database/schema.sql`, every table with its RLS policy and
`ENABLE ROW LEVEL SECURITY` in the same file.

```
email_receipt_mailboxes              -- one per user (unique user_id)
  id, user_id
  host varchar(255), port int (1..65535), security varchar(10) 'tls'|'starttls'
  username varchar(320), password_enc text null -- EncryptionService; never returned
  auth_method varchar(10) default 'password'  'password'|'oauth2'
  oauth_provider varchar(12) null  'google'|'microsoft'
  oauth_refresh_token_enc text null             -- EncryptionService; never returned
  folder varchar(255) default 'INBOX'
  enabled bool default false
  ai_mode varchar(12) default 'off'  'off'|'on_demand'|'automatic'
  auto_apply bool default false
  uid_validity bigint null, last_uid bigint null  -- the cursor
  last_polled_at, last_success_at, last_error varchar(300), last_error_at
  created_at, updated_at

email_receipt_parsers
  id, user_id, name varchar(100)
  payee_id uuid null -> payees ON DELETE SET NULL
  from_domains text[] (1..10 entries, lower-case, no '@')
  subject_contains text[] (0..10)
  definition jsonb                               -- section 5
  status varchar(10) 'draft'|'approved', source varchar(10) 'manual'|'ai'
  approved_at timestamptz null, revision int     -- compare-and-swap
  created_at, updated_at

email_receipts
  id, user_id, mailbox_id -> email_receipt_mailboxes ON DELETE CASCADE
  uid_validity bigint, uid bigint, message_id varchar(500) null
  from_address varchar(320), from_domain varchar(255), subject varchar(500)
    -- the ORIGINAL sender and subject when the email was a forward (decision 12)
  received_at timestamptz, body_text text (<= 100,000 chars)
  body_html text null (<= 1,000,000 chars)       -- shown, and read for the html lines source and the schema.org order; never sent to a model
  forwarded_by varchar(320) null                 -- the mailbox From of a forward
  original_sent_at timestamptz null              -- the day the shop sent the order
  status varchar(20)  -- section 6
  status_reason varchar(40) null
  parser_id -> email_receipt_parsers ON DELETE SET NULL
  parsed jsonb null                             -- ParsedReceipt, section 5.3
  transaction_id -> transactions ON DELETE SET NULL
  candidate_transaction_ids uuid[] (<= 10)
  match_kind varchar(20) null  'order_id'|'amount_payee'|'amount_only'|'manual'
  ai_review_request_id uuid null (no FK: the request table references this one)
  created_at, updated_at
  UNIQUE (mailbox_id, uid_validity, uid)        -- ingestion idempotency

ai_review_requests (widened)
  kind CHECK widened to ('transaction_review', 'email_receipt', 'email_parser_draft')
  email_receipt_id uuid null -> email_receipts ON DELETE SET NULL
  transaction_id DROP NOT NULL, held by CHECK (kind = 'email_parser_draft' OR
    transaction_id IS NOT NULL)
  email_receipt_ids uuid[] null (<= 5)           -- email_parser_draft only, no FK
  parser_domain varchar(255) null                -- email_parser_draft only
  CHECK parser_draft_shape: an email_parser_draft has no transaction, 1..5 emails
    and a domain; every other kind has neither new column
  UNIQUE (user_id, parser_domain) WHERE kind = 'email_parser_draft' AND status
    IN ('pending', 'claimed', 'proposed')
```

A request of kind `email_parser_draft` is about emails, not a transaction. The
existing partial unique index on `(transaction_id, rule_id)` still ignores it
(NULL transaction ids are distinct). **At most one open parser-draft request per
(user, sender domain)** is held by its own partial unique index on the new
`parser_domain` column (a column rather than an advisory lock alone, so the rule
is a constraint the database enforces and the inbox can show the domain after the
emails are deleted). Creating one is a replace: under a transaction advisory lock
on `<user>:<domain>` the open request for that sender is closed (`rejected`, or
`expired` when it had run out) and the new one inserted, in one transaction, so
asking again with a different selection never fails and two concurrent askers
leave exactly one open request. A draft parser the earlier request already
produced is not touched. The migrations are expand-only (`email_receipts` columns
nullable; the CHECKs accept every row the previous release writes).

The existing partial unique index on `(transaction_id, rule_id)` while a
request is open is kept unchanged (its predicate is what the running
`enqueue`'s `ON CONFLICT` infers during a rolling deploy). Its consequence is a
decision: one open request without a rule per transaction. A receipt whose
transaction already has an open manual or receipt request is reported as
`review_conflict` and can be reprocessed once that request closes.

Backup: `email_receipt_mailboxes` is excluded (an encrypted credential for
another instance's key, like `backup_offsite_settings`); `email_receipts` is
excluded (a mailbox copy the user can re-read); `email_receipt_parsers` is
exported, and its support-backup rules drop the free text. Section 11 records
the trade.

## 5. The parser

### 5.1 Definition (`definition` jsonb, version 2)

There is one parser language, version 2. A version 1 definition (one line
pattern per field, the first matching line wins) was replaced before any parser
used it: the validator refuses any other `version` with `unsupported_version`,
and a stored definition that fails validation is listed as invalid and is saved
again, never read by another rule.

```json
{
  "version": 2,
  "orderId": ["*order #{orderid}*", "Order number: {orderid}"],
  "total": ["Order total: {amount}", "*Grand total*{amount}"],
  "shipping": ["Shipping: {amount}"],
  "discount": ["Discount: {amount}"],
  "items": {
    "startAfter": "Items in your order",
    "stopAt": "Subtotal",
    "patterns": ["{qty} x {name} {amount}", "{name} {amount}"]
  },
  "categoryRules": [
    { "match": "*cable*", "categoryId": "<uuid>" },
    { "match": "*book*", "categoryId": "<uuid>" }
  ],
  "defaultCategoryId": "<uuid>",
  "shippingCategoryId": "<uuid>"
}
```

An optional top-level `"source": "text" | "html"` (default `"text"`) says
which lines every pattern, guard and trace line number refers to: the email's
text (`body_text`, one line per line break) or the lines of its HTML part (see
"Lines source" below). An email that prints a caption on one line and its value
on a later one, and a product over several lines (the Allegro "Kupiłeś i
zapłaciłeś" mail), reads with labelled entries and block items:

```json
{
  "version": 2,
  "orderId": ["*/moje-allegro/zakupy/kupione/{orderid}?*"],
  "total": [{ "label": "RAZEM", "value": "{amount} zł", "within": 3 }],
  "shipping": [{ "label": "Metoda dostawy", "value": "{amount} zł", "within": 4 }],
  "items": {
    "startAfter": "od ",
    "stopAt": "Metoda dostawy",
    "skipLines": ["<*>", "(*)"],
    "record": [
      { "line": "{name}" },
      { "line": "{amount} zł" },
      { "line": "{qty} × {price} zł", "optional": true }
    ]
  },
  "defaultCategoryId": "<uuid>",
  "shippingCategoryId": "<uuid>"
}
```

A payment gateway's notice, and a Google Play receipt with a promotion, read
with `paid`, `payee`, `items.single`, `joinWrapped` and the literal asterisk:

```json
{
  "version": 2,
  "requireLine": ["*PayU*"],
  "orderId": ["Numer transakcji: {orderid}"],
  "total": ["Kwota: *{amount} PLN*"],
  "paid": ["Kwota: *{amount} PLN*"],
  "payee": [{ "label": "Sprzedawca", "value": "{payee}", "within": 2 }],
  "items": { "single": { "name": "Opis płatności: {*}{name}{*}" } },
  "categoryRules": [{ "match": "*OLX*", "field": "payee", "categoryId": "<uuid>" }],
  "defaultCategoryId": "<uuid>"
}
```

```json
{
  "version": 2,
  "orderId": ["*Numer zamówienia:* {orderid}"],
  "total": ["Razem: {amount} zł"],
  "paid": ["Visa-*: {amount} zł", "Razem: {amount} zł"],
  "discount": ["*{*} -{amount} zł"],
  "items": {
    "startAfter": "Produkt Cena",
    "stopAt": "Razem",
    "joinWrapped": true,
    "patterns": ["{name} (deweloper: *) {amount} zł", "{name} {amount} zł"]
  },
  "defaultCategoryId": "<uuid>"
}
```

Amazon.pl, whose mail names the product only inside `[image: ...]` (the line
under the link is cut), drops the lines between the name and the quantity and
gives its one item the order total:

```json
{
  "version": 2,
  "orderId": ["Nr zamówienia {orderid}"],
  "total": ["Suma {amount}"],
  "items": {
    "startAfter": "Wyświetl lub edytuj zamówienie",
    "stopAt": "Suma",
    "skipLines": ["<*>", "*zł", "Sprzedawca *", "Stan: *", "*..."],
    "record": [{ "line": ["[image: {name}]", "{name}"] }, { "line": "Ilość: {qty}" }]
  },
  "defaultCategoryId": "<uuid>"
}
```

- **Lines source.** `source` is `text` (the default) or `html`; the validator
  refuses anything else with `invalid_value` at path `source`. The `html` lines
  come from one streaming pass over `body_html` (`htmlToReceiptLines`, no
  document tree is kept): every block element (`p`, `div`, `br`, `tr`, `li`,
  `h1`-`h6`, `table`, `section`, `article`, `header`, `footer`, `blockquote`,
  `hr`, and the list, definition and table-section elements) and EVERY table
  cell (`td`, `th`) ends the line, so a cell is a line and a product name that
  the text conversion wraps over several lines is one line; inline text is joined
  with single spaces; `head`, `title`, `script`, `style`, `noscript` and
  `template` show nothing; an `<img alt="X">` with a non-empty alt is its own
  line `[image: X]`; an `<a href>` adds its text inline and, for an `http` or
  `https` href only, its own line `<href>` (what Gmail's text part shows; a long
  href is cut inside the brackets so the line still ends in `>`); entities are
  decoded; then the lines get the normalisation a text line gets (invisible
  characters dropped, whitespace folded, 500 characters a line, empty lines
  dropped, 2,000 lines, the input capped at the stored 1,000,000 characters).
  The two sources are numbered separately: a trace's line numbers are the
  chosen source's, and the email's detail dialog has a "Lines" view that shows
  both. A forwarded email's header block is detected on the TEXT
  (`detectForwardedOriginal`) and is not removed from either source's lines; the
  Gmail forward banner and the From/Date/Subject/To lines are ordinary lines at
  the top of the HTML lines, which no item pattern reads and `startAfter` skips.
  A parser with `source: "html"` on an email with no `body_html` reads nothing:
  the pipeline stores `parse_failed` with `status_reason` `no_html` (and the
  parser id), or, when another parser for the sender applies, that one reads the
  email; the test operation answers `outcome` `no_html`.
- Every pattern is a rule glob (`*` wildcard, `{name}` capture), matched
  case-insensitively against one whole line (the lines of the chosen source: for
  `text`, the email's non-empty lines,
  whitespace folded, invisible characters such as zero-width spaces, bidi
  marks and soft hyphens removed). A line pattern of `orderId` is tried on the
  subject first, then on each line.
- **Multi-line patterns.** The two characters `\n` in a pattern split it into
  parts, each a whole-line glob as above, matched against consecutive lines (the
  non-empty normalised lines, so blank lines between them do not count):
  `Receipt from *\n{amount}\nPaid` reads a total printed between two lines, and
  a part of only `*` is any one line. Each part is read lazily, then greedily,
  and the first combination of the parts' readings the field accepts wins
  (merged captures; a capture name is in one part only). Wherever lines are
  read a pattern may span them: every field entry (and a labelled entry's
  `label` and `value`, its `within` counted from the label's last line), the
  line guards, `line` category rules, trade currency markers, item `patterns`
  (the next item starts after the last line taken; tried without held
  `joinWrapped` lines), record steps, `skipLines` (every line matched is
  dropped) and `single.name`. Where one text is matched (the subject, an item
  name or the payee of a category rule, a trade account rule) a multi-line
  pattern never matches; the validator refuses one in a category rule over an
  item or the payee and in a trade account rule (`line_break_not_allowed`). A
  fee is counted once per line its `{amount}` part read. A line holds no line
  break, so the escape takes nothing a line could contain; a stored pattern
  that meant a literal backslash and `n` no longer matches.
- **Literal asterisk and trimming.** `{*}` and `\*` in a pattern are a literal
  `*` (the receipt matcher swaps each literal `*` of the pattern and of the line
  for a private-use character, matches, and swaps it back in the captures; the
  rule matcher is untouched). Every captured value is trimmed of leading and
  trailing whitespace, `*` and `_`, because Gmail draws bold as `*text*`; the
  accept rules see the trimmed value. There is no opt-out.
- Capture names: `orderid` (order patterns), `amount` (total, paid, shipping,
  discount), `payee` (the merchant), and in items `name` (required), `amount`
  (the line total) or `price` with `qty` (the line total is `price * qty`),
  `qty` optional (default 1).
- **`paid` and the arithmetic.** `total` is the amount the email calls the
  total (a list price), `paid` the amount actually charged (a card line after a
  promotion). `gross` = items + shipping; `net` = `gross` - discount (a missing
  discount is 0, and a discount above `gross` is unbalanced). A receipt is
  complete only when at least one of `total` and `paid` is found, `paid` (when
  found) equals `net`, and `total` (when found) equals `gross` OR `net`; the
  first of the truth table that fails is the reason. The bank amount a receipt
  is matched and proposed against is `paid`, else `total`.
- **`payee`.** The merchant when it is not the sender (a payment gateway).
  Entries have the same shapes as `total`. It is `ParsedReceipt.payee`
  (`null` when none).
- **Priority by array order.** A field's entries (`orderId`, `total`,
  `shipping`, `discount`) are tried in array order, each over the whole email:
  entry 0 first (a line pattern: the first line that matches and holds an
  accepted value; a labelled entry: below), then entry 1 only when entry 0 found
  nothing anywhere. A specific entry goes first, a general one after it. For
  `orderId` a line pattern reads the subject, then the lines, per entry.
- **Labelled entries.** An entry is a string (a line pattern) or
  `{ "label", "value", "within" }`. `label` is a capture-free glob matched
  against a whole line; `value` is a glob with the field's capture; `within`
  is a whole number from 1 to 10 (default 3). The reader finds a line matching
  `label`, then looks at the next `within` lines (the non-empty normalised
  lines, so a blank line does not use up the window) and takes the FIRST one
  whose `value` matches and holds an accepted value; if none does, it goes on
  to the next line matching `label`. A labelled `orderId` entry reads lines
  only, never the subject. The label's own line is never the value.
- **Accepted values.** An amount is a plain amount (the spec's amount grammar)
  that holds no operator character (`×`, `÷`, `+`, `*`, `/`, `=`, `%`, `<`,
  `>`, `@`, `#`, `\`, `|`), so a quantity line such as `3 × 1,47 zł` is never
  an amount. The only letters it may hold are a currency code or mark (`zł`,
  `EUR`, `kr`) or a dollar sign's country prefix (`US$`, `C$`, `CA$`, `CDN$`,
  `A$`, `AU$`, `NZ$`, `HK$`: the trade reader's `DOLLAR_PREFIXES`), so a name
  ending in digits is not an amount. An order id is a non-empty first token.
  A zero amount is a value.
- **Items** hold exactly one of `patterns` (one item per line), `record` (an
  item over several lines) and `single` (one item for the whole email);
  `startAfter` / `stopAt` are plain case-insensitive substrings bounding the
  section in all three shapes: items are read from the line after the first
  line containing `startAfter` (or from the top) up to the first line
  containing `stopAt` (or the end).
- **`joinWrapped`** (patterns only). A section line no pattern reads is held,
  at most the last three; the next line is read as the held lines, then itself,
  joined by single spaces, and an emitted item clears what was held. It is for
  a name wrapped over lines with the price on the last (Google Play).
- **`single`.** `{ "name": <glob with {name}> }`: one item named by the first
  section line the glob reads, quantity 1, its amount the email's `total`, else
  `paid`. With a discount the item therefore carries the `total` (the gross).
  No item when no line gives a name or the email states neither amount.
- **An item without an amount.** An item a `record` or `single` read with no
  `amount` or `price` takes `total`, else `paid`, when it is the ONLY item;
  with two or more items, or when the email states neither, it is dropped and
  the reason is `item_amount_missing` (checked after `no_total`).
- **Block items.** `skipLines` (0 to 10 capture-free globs) drops the section
  lines matching any of them first (links, offer numbers). Then a cursor walks
  the remaining lines. `record` is 1 to 6 steps `{ "line", "optional" }`, each
  a glob over one line with the item captures. From the cursor, each step
  consumes one line when its glob matches and its values read (an amount or
  price is a plain amount, `qty` a whole number from 1 to 9999, `name`
  non-empty); an optional step that does not match consumes nothing; a required
  step that does not match fails the record. A step's `line` may be a list of
  up to 5 alternative globs, tried in order; the first that matches and reads
  wins (`["[image: {name}]", "{name}"]`). A matched record is one item: its
  captures are merged across the steps (a capture name belongs to one step),
  the line total is the `amount` capture if there is one, else `price * qty`,
  and `qty` defaults to 1; the cursor moves past the consumed lines. A failed
  record moves the cursor ONE line, so the next product is still found (a name
  that appears twice is read once). The record must capture `name`.
- **Category rules.** `categoryRules[].field` is `item` (the default: the glob
  is matched against the item's name), `payee` (against the parsed payee; it
  covers every item) or `line` (against any line of the email; every item).
  Rules are tried in order and the first that covers an item wins; then
  `defaultCategoryId`, then the parser payee's default.
- **Line guards.** `requireLine`, `skipIfLine` and `waitIfLine` are lists of up
  to 10 capture-free globs. `requireLine`: the parser applies only to an email
  with a line matching one of them; otherwise the pipeline tries the next
  parser for the sender (best first: the longer domain, the older, the lower
  id), and `no_parser` when none is left. `skipIfLine`: a matching line makes
  the receipt `ignored` with `status_reason` `skip_line` (nothing is parsed or
  matched). `waitIfLine`: it leaves the receipt `unmatched` with `status_reason`
  `wait_line`; the poll's rematch (recent `unmatched` receipts) reads the whole
  email again from the top, parser selection included, so it is read normally
  once the line is gone. `skipIfLine` wins over `waitIfLine`; a person's own
  link is a command and no guard holds it back. `status_reason` is free text
  (40 characters, no CHECK), so no migration is needed.
- **Discarding profiles.** `discard: "ignore" | "delete"` makes a profile for
  mail that is never wanted: every email the pipeline gives the profile (its
  sender domains, subject words and `requireLine`, ranked against the other
  profiles as usual) is ignored with `status_reason` `profile_ignore`, or
  deleted with its open requests (`deleteLockedReceipt`), before any other
  guard or field is read. A person's own link is a command and still reads the
  email. The test operation and the preview answer the outcome
  `discard_ignore` / `discard_delete`; `process-batch` counts a deleted email
  in `processed` and `deleted`, under no status; a person's Reprocess of an
  email its profile deletes answers no detail. The editor sets it with one
  select ("Matching emails": read, ignore, delete) and hides the reading
  fields while it is set; saving or approving such a profile offers to do the
  same to the stored emails it matches (`profile-batch` below), counted first.
- **The test trace.** `POST /email-receipt-parsers/test` and the tool's `test`
  return, beside `parsed`, an `outcome` (`read`, or the guard that would stop
  the read: `not_applicable`, `skip_line`, `wait_line`, `discard_ignore`,
  `discard_delete`) and a `trace`: for
  `orderId`, `total`, `paid`, `shipping`, `discount`, `payee` and the three
  guards the entry index, the glob (a labelled entry: its `value`, its `label`
  and the label line) and the line (1-based number among the email's lines, 0
  for the subject, and its text cut to 200 characters) that produced the value
  (a multi-line pattern: its first line, and `lines`, every line it matched),
  and for each item (at most 20 in the tool's answer) the globs and lines that
  read it. The editor's test panel lists them under "Matched by".
- A line item's category is the first `categoryRules` entry whose glob matches
  the item's name, else `defaultCategoryId`, else the parser payee's default
  category, else none.

### 5.2 Bounds (validated on save, by the same validator the AI draft passes)

At most 10 entries per field, 200 characters per pattern (and per `label` and
`value`), 5 captures per pattern (the glob's own limit), 50 category rules, 100
characters per section marker, 10 `skipLines`, 6 record steps, 5 alternatives
per step, 10 globs in each line guard, 3 held lines for `joinWrapped`, `within`
1 to 10, 5 lines per multi-line pattern (no part empty);
unknown keys refused; every category id owned by the user (checked in the
write's transaction). Parsing reads at most 2,000 lines and 100 items. A
labelled entry matches each line against its `value` once however many label
lines look at it, and a record is tried once per line, so reading is linear in
the lines for any definition within the bounds.

The validator's codes, each at the path of the problem: `not_object`,
`unknown_key`, `unsupported_version`, `invalid_type`, `empty`, `too_many`,
`too_long`, `control_character`, `malformed_capture`, `too_many_captures`,
`duplicate_capture`, `capture_not_allowed`, `capture_missing`,
`capture_conflict`, `invalid_uuid`, `out_of_range` (`within`),
`items_patterns_and_record`, `items_single_conflict`, `items_shape_missing`,
`skip_lines_need_record`, `join_wrapped_needs_patterns`, `record_name_missing`,
`invalid_value` (a category rule `field`, or the top-level `source`),
`too_many_lines` (a multi-line pattern over 5 parts), `line_break_not_allowed`
(a multi-line pattern where one text is matched).

### 5.3 Output (`ParsedReceipt`)

`{ orderId, total, shipping, discount, items: [{ name, qty, amount,
categoryId }], complete, reason, source? }` (`source` is `"ai"` when the AI read
the email, `"schema_org"` when its own structured data did, absent for a
parser), every amount a non-negative integer in
1/10000 units. `complete` is true only when `total` or `paid` was found, the items plus
shipping (gross) and minus the discount (net) agree with them as section 5.1
says, and every item and the shipping line (when present) has a category. The
object also carries `paid` and `payee` (`null` when the email states none). `reason` names the first missing
thing otherwise. The spec has the amount grammar and the truth table.

### 5.4 Reference and tag

`reference` is a pattern field read exactly like `orderId` (capture `{reference}`,
the subject first, then the lines, the first token kept): the identifier a shop or a
payment gateway puts into the bank operation, a statement text or a transfer title.
It is a matching signal and nothing else; it is not shown as an order number. `tag`
is a string of 1 to 50 characters: the proposal for a transaction the profile
categorizes also adds that tag, found by name (case-insensitive, the user's own) or
created. The tag is additive: the card lists it ("Tags: X (new)"), `confirm` finds
or creates it and adds a `transaction_tags` row in the same transaction as the edit,
and no existing tag is removed. A proposal that only changes the description carries
no tag, because nothing was categorized.

### 5.5 Matching, configured by the profile

Which bank transaction an email paid for is the profile's decision, in its optional
`match` section (all keys optional; spec 3a has the truth table):

```json
"match": { "by": ["reference", "orderId", "amount_payee"], "referenceIn": ["description"],
           "daysBefore": 3, "daysAfter": 14, "amountTolerance": "0.50" }
```

- `by`: the strategies, in the order tried, each at most once, any of `reference`,
  `orderId`, `amount_payee`, `amount_date`. The default (`orderId`, `amount_payee`,
  `amount_date`) reproduces the matching a profile without the section always had.
  `reference` in `by` needs a `reference` field (`reference_field_missing`).
- `referenceIn`: the transaction fields a reference or an order id is looked for in:
  `description`, `payee`, `referenceNumber` (default all three).
- `daysBefore` 0 to 60 (default 3) and `daysAfter` 0 to 90 (default 14): the
  candidate window around the purchase date. The candidate loader reads the window
  of the profile that read the email, so a wider window is a wider query (still at
  most 200 rows, newest first).
- `amountTolerance`: a decimal string `"0.00"` to `"5.00"` (default `"0"`). The amount
  signal holds when the bank amount is within it of what was paid, compared as integers
  in 1/10000 units. A tolerance never lets an email auto-apply: the gate still demands
  `abs(T) = paid ?? total` exactly.

`match_kind` gains `reference` and `amount_date` (a migration widens the CHECK; the
legacy `amount_only` stays readable and is never written again). The matcher reports
what it tried (`attempts`: strategy, how many candidates it kept, the closest ten),
how many candidates the window held and which strategy decided. The test panel and the
`email_receipt_parsers` tool's `test` return that trace per email, so a person or an
agent that tunes a profile sees why an email matched, was ambiguous or found nothing.
The validator reports `match` problems at their own paths (`match.by[1]`,
`match.daysBefore`, ...), and the tool's guide describes the section in a few lines (the
MCP tools list must not grow, `tools-list-budget.spec.ts`).

### 5.6 Categories chosen by the AI

`aiCategories: true` lets the AI choose the category of an item no `categoryRules`
entry matched and no `defaultCategoryId` covers. Without it nothing changes: such an
email stays description-only, and the AI is never called for it (a source-scanning
unit test holds that). With it, in the order below:

1. The reading is complete and the profile is approved, and at least one item has no
   category.
2. When the user's AI provider can answer now (`AiService.canAnswerNow`), one bounded
   call (`AiService.complete`, `responseFormat: "json"`, feature `email_receipt_categories`)
   gets the uncategorized item names, the user's category list (ids and names) and the
   merchant, framed as untrusted data. The output is validated (zod): an index outside
   the items, an id that is not the user's category, or a second answer for an item is
   dropped. A chosen category marks the item `categorySource: "ai"`; the card and the
   test panel show it as the AI's, and it is display-only (never signed, never a reason to
   auto-apply).
3. Otherwise a request with the instruction `RECEIPT_CATEGORIZE_INSTRUCTION` is queued in
   the inbox for an agent, like "Recognize with AI". There is one open rule-less request
   per transaction, so it replaces the description-only proposal that would otherwise be
   stored (a deliberate deviation from "a proposal is never replaced by a question": a
   description-only proposal would have hidden the fact that categories were asked for).
4. The poll's automatic step never takes this path (INV-RECEIPT-003 holds either way,
   because the result is a proposal), and a poll asks at most 10 such questions, a bulk
   call at most 25; the rest are queued. The AI call sits between two transactions of the
   pipeline, never inside a database transaction (`docs/external-side-effects.md`).

## 6. Pipeline and receipt states

```
poll -> store (status pending); a forwarded email is stored as the shop's
        (decision 12)
     -> choose parser (by the shop's domain): none -> the email's schema.org
               order when it states a total and a line (decision 13), else
               no_parser; a parser that reads html on an email with no html
               -> parse_failed (no_html)
     -> parse (the lines of the parser's source): no total and no paid -> the
               schema.org order when usable; else no total -> parse_failed
     -> match, window centred on original_sent_at ?? received_at:
               none -> unmatched (retried 30 days) | several -> ambiguous
     -> propose: an open request exists -> review_conflict
               | proposal stored (status review)
     -> auto-apply (opt-in, section 3.7)
user -> link to a transaction (any state but ignored) -> propose
     -> ignore -> ignored
     -> reprocess -> back to the top (a closed request is not reopened)
     -> recognize with AI (any AI mode; transaction chosen or confirmed)
        -> request pending, email in review, chat opened with the email
        -> the assistant claims it by id and submits -> proposed
        (no provider, or a relay agent not connected: stays pending in the
        inbox for an agent)
user -> draft parser with AI (1 to 25 emails, 5 per sender, any AI mode)
        -> request email_parser_draft pending (no transaction, no email state
           change), chat opened with the emails (or it waits in the inbox)
        -> the assistant claims it by id, tests, save_draft -> proposed
           (a DRAFT parser exists; it reads nothing)
        -> the user approves the parser -> applied (same transaction)
           the user deletes the parser -> dismissed
```

**The schema.org reading** is computed at process time from `body_html` (nothing
is stored at ingestion): `orderFromStructuredData` over the JSON-LD scripts and
microdata that the same single pass collected (`ReceiptSourceLines`), then
`schemaOrgToParsedReceipt` (spec "Structured data"). It is judged by the same
`completeness` and goes through the same matching, `buildReceiptProposal` and
`AiReviewWorkService.submit` as a parser's reading, inside the same transaction.
`status_reason` is `schema_org` when the outcome has no more specific reason of
its own (`amount_differs`, `items_uncategorized`, `proposal_fallback`, ... keep
theirs; `parsed.source` records the reader either way). It never auto-applies,
and in `automatic` AI mode an incomplete reading asks the AI like an incomplete
parser's.

The pipeline's first step under the receipt's row lock is the forwarded-identity
heal (`healForwardedIdentity`): the stored text is read again and, when it holds a
forwarded header block the columns do not yet reflect, `from_address`,
`from_domain`, `subject`, `forwarded_by` and `original_sent_at` are brought up to
date before the parser is chosen. It writes nothing for an email that is no
forward or is already healed.

`skipped` is a message larger than the size cap or that could not be decoded
(`status_reason` says which). The receipts page derives the shown state of a
`review` receipt from its request: `proposed`, `applied`, `dismissed`,
`expired` or `pending_ai`.

The proposal uses `AiReviewWorkService.submit` as an agent does, with the
claim key `email-receipts` (deterministic), `email-receipts-ai` (the poll's
automatic AI step) or `assistant` / an MCP caller key (the chat, or an agent,
answering a request "Recognize with AI" queued): the receipts service inserts a
deterministic request already claimed by its key, then submits; an AI request is
inserted `pending` and claimed by whoever answers it.

A deterministic proposal the validation refuses (the lines do not add up, a category
was deleted) falls back to the description-only proposal; if that is refused
too, the request is released as rejected with the reason, and the receipt
shows it.

**"Recognize with AI" in one transaction.** `POST /email-receipts/:id/ask-ai`
`{ transactionId? }` locks the receipt row, refuses (409) an ignored or skipped
email and an applied request, checks a chosen transaction with the predicate
"link" uses (`loadLinkableTransaction`: the user's, not a transfer, not VOID, not
investment-linked) and stores it as `manual`, refuses (400) an email that still
has no transaction, takes the advisory lock, dismisses the email's own open
request, queues a `pending` `email_receipt` request (a null from the queue, another
open rule-less request on the transaction, is a 409), and sets the receipt to
`review` pointing at it. It answers `{ ok: true, requestId, transactionId }` and
calls no provider. A rejection has written nothing.

**Answering by id.** `ai_review_requests` `claim` takes an optional `requestId`:
`claimById` takes that one pending request (a conditional UPDATE) instead of the
oldest, and returns the same payload, with the email's text for an
`email_receipt` request. On the assistant, `submit` returns the signed card as a
pending action in the chat; confirming it marks the request applied in the write's
own transaction (`aiReviewRequestId` in the descriptor).

**The poll's automatic step** (`processAiRequest`, mode `automatic`) takes only the pending requests the poll itself queued (their `instruction` is `RECEIPT_AUTOMATIC_AI_INSTRUCTION`; "Recognize with AI" queues `RECEIPT_CHAT_INSTRUCTION`, which belongs to the chat or an MCP agent) and asks the
model for the receipt's content, not a split: `{ orderId, items: [{ name, qty,
amount, categoryId }], shipping, shippingCategoryId, discount,
discountCategoryId, total, description }`, amounts as the email writes them. The answer becomes a `ParsedReceipt` (`source: "ai"`), is
judged by the same completeness function a parser's reading is, and goes through
`buildReceiptProposal` and `AiReviewWorkService.submit` (spec "AI extraction").

What a proposal contains:

- **Complete parse and the transaction amount equals the parsed total**: split
  lines, one per item (memo `name` or `name x qty`), plus shipping and discount
  lines, each signed like the transaction; a single line is not a split but a
  category. The description is the existing one with ` | ` and the summary
  appended (capped at 750).
- **Anything else**: the description only, with the summary; the receipt page
  names the reason (`amount_differs`, `items_uncategorized`, ...).
- **Ref #**: the order number, when the transaction's Ref # is empty (never
  over another value; then it stays in the summary). See
  `docs/specs/email-receipt-matching.md`.
- **Payee**: the parser's payee name when the transaction has none.

## 7. Invariants

| ID | Statement | Mechanism |
|---|---|---|
| INV-RECEIPT-001 | The mailbox is read, never written | The IMAP client opens the folder with `readOnly: true` and fetches with `BODY.PEEK`; the client module exposes no flag, move, delete or append call; a unit test asserts the options and a source scan asserts that `messageFlagsAdd`, `messageMove`, `messageDelete`, `append` never appear |
| INV-RECEIPT-002 | A receipt is ingested once | `UNIQUE (mailbox_id, uid_validity, uid)` with `ON CONFLICT DO NOTHING`; the cursor advances in the transaction that inserts the rows |
| INV-RECEIPT-003 | A receipt changes the ledger only through an approved (or opt-in auto-applied) card, and never moves money | The proposal is `AiReviewProposalInput` (no amount, date, account or status); it is written only by `/ai/actions/confirm` with `markApplied` in the same transaction; auto-apply calls the same `confirm` with the card it built |
| INV-RECEIPT-004 | The mailbox connection reaches only a public address unless the owner is an admin or the operator allowed the host | The host is checked on save (IP literal, blocked names, DNS) and at connect (`publicOnlyLookup` passed as the socket's `lookup`, IP literal refused) |
| INV-RECEIPT-005 | The password and the OAuth refresh and access tokens are encrypted at rest (or held only in memory) and never returned | `EncryptionService.encrypt`; the view carries `passwordSet` / `oauthConnected` booleans; the table is excluded from backups; errors are logged through `describeFetchFailure`, never with a secret |
| INV-RECEIPT-007 | An OAuth callback completes only the flow the same user started, once | The `state` envelope is encrypted, expires in 10 minutes, carries the user id checked against the JWT, and its nonce is claimed with `SingleUseTokenService` |
| INV-RECEIPT-006 | One poll per mailbox at a time across replicas | `JobClaimService.claimLease(EmailReceiptPoll, userId, mailboxId)` around the poll, released by token |

`docs/system-invariants.md` carries each with an honest status.

### 7.1 The daily limit of AI-proposed writes

Every confirmed AI proposal is counted by `AiWriteLimiter`. A mailbox has the switch
`profile_proposals_count_toward_ai_limit` (default true): when it is off, a proposal that
a profile built (`claimed_by = 'email-receipts'`) is neither counted nor refused by the
limit, so a first run over hundreds of stored emails does not use the day's allowance up
for the user's other AI edits. The exemption is decided on the server, from the stored
request's claimant and the stored switch, at confirm; the client sends nothing that could
claim it, and a proposal an AI or an agent built always counts. Nothing else about the
card changes: it is still signed, still single-use, still approved by a person (or by the
auto-apply gate).

## 8. Backend

Module `backend/src/email-receipts/`:

- `mailbox/`: entity, DTOs, `EmailReceiptMailboxService` (get view, upsert,
  delete, test connection), host policy.
- `imap/`: `ImapMailboxClient` (the only file importing `imapflow`),
  `mail-text.util.ts` (the only file importing `mailparser`; HTML to text,
  line normalisation, caps, and the HTML part kept for display),
  `html-lines.util.ts` (the only file importing `htmlparser2`; one streaming
  pass over the HTML part: `htmlToReceiptLines`, and the JSON-LD scripts and
  microdata items for `schema-org-order.ts`; bounded in depth, nodes, scripts and
  lengths),
  `forwarded-message.ts` (pure: `detectForwardedOriginal`, the header block of a
  forward in the text, bounded to the first 200 lines, no regular expression
  built from input) and `forwarded-receipt.ts` (pure: the identity columns a
  forward changes, idempotent; `effectiveReceiptDate`).
- `parsing/`: definition types, validator, `parseReceiptLines(definition, subject,
  lines, fallback)` (and the text wrapper `parseReceipt`), amount grammar,
  `schema-org-order.ts` (`extractSchemaOrgOrder`, `orderFromStructuredData`,
  `schemaOrgToParsedReceipt`). Pure.
- `pipeline/receipt-source-lines.ts`: `ReceiptSourceLines`, the lines of one
  stored email by source and its structured data, each computed once; the one
  place a definition's `source` chooses lines (the pipeline, the REST `test`
  and the tool's `test`).
- `matching/`: `matchReceipt(parsed, candidates, parserPayeeId)`. Pure.
- `proposal/`: `buildReceiptProposal(parsed, transaction, context)`. Pure.
- `EmailReceiptsService`: list, get, link, ignore, delete, reprocess, ask AI.
- `EmailReceiptPipelineService`: parse, match, propose for one receipt.
- `EmailReceiptPollService`: the `@Cron` (every 15 minutes), per-user lease,
  ingestion, rematch of `unmatched`, the automatic AI step.
- `EmailReceiptAiService`: draft a parser from a receipt; `askAi` (queue the
  "Recognize with AI" request, no provider call); `processAiRequest` (the poll's
  automatic step: read the email's content, build a `ParsedReceipt`, propose).
  Uses `AiService.complete` with `responseFormat: "json"`, feature labels
  `email_receipt_parser` and `email_receipt_review`; the email text is
  sanitized, truncated and framed as untrusted data.
- `EmailReceiptParsersService` + controller: CRUD, approve, test against a
  stored receipt, and `requestAiDraft` (`POST /email-receipt-parsers/draft-with-ai`
  `{ receiptIds }`: 1 to 25 distinct emails of the user, none skipped, at most five
  per sender domain and five domains (a trade draft: one domain), a 400 before any
  write otherwise; queues the request, calls no provider). Approving a parser marks the `proposed`
  parser-draft request that proposed it `applied`, deleting it dismisses that
  request, each in the transaction of the change itself.
- `EmailReceiptParserToolsService` (module `EmailReceiptParsersModule`, a leaf the
  assistant's executor, the MCP server and `EmailReceiptsModule` all import, so
  the AI module needs no edge to the receipts module): the logic of the shared AI
  tool `email_receipt_parsers`. `categories` lists the user's category ids;
  `test` reads 1 to 25 stored emails with an unsaved definition and returns what
  each parsed (decimal amounts, category names, `valid` / `errors` /
  `unknownCategoryIds` / `allComplete`), writing nothing; `save_draft` stores a
  `draft` parser of source `ai` through the one validator (payee resolved with
  `PayeesService.resolveByName`, never created), and when `requestId` names a
  parser-draft request the caller claimed, marks it `proposed` with
  `{ parserId }` in the same transaction (the request row is locked and checked
  first, so a refusal has written nothing). It needs no confirmation card or write
  cap, like `ai_review_requests` `submit`: a draft reads no mail until the user
  approves it, and never touches the ledger (INV-RECEIPT-003).
- The old synchronous `POST /email-receipts/:id/draft-parser` route is gone; the
  poll's automatic mode still drafts internally (`EmailReceiptAiService.draftParser`).

The AI review queue gains the `email_receipt` kind, `claimById`, and an
`enqueueClaimed` producer; the MCP and assistant `claim` result carries the
email (sender, subject, date, text up to 20,000 characters) for that kind, so
an MCP agent can answer a receipt request too. The `email_parser_draft` kind has
`enqueueParserDraft` (the replace under the advisory lock above), a claim that
returns `emailReceipts: [{ id, fromAddress, subject, effectiveDate, text }]` (up
to five, each text cut to 12,000 characters, the shop's day for a forward) and no
transaction, and the generic `submit` refuses it (the tool is
`email_receipt_parsers`). Every reader of a request tolerates a null
`transaction_id` (the inbox listing, claim, expiry).

Environment (operator, all optional): `EMAIL_RECEIPTS_MAX_MESSAGES_PER_POLL`
(50), `EMAIL_RECEIPTS_MAX_MESSAGE_BYTES` (2,000,000),
`EMAIL_RECEIPTS_PRIVATE_HOST_ALLOWLIST` (empty), and the OAuth clients of
section 3a.

### 8.1 Bulk work, the overview and approving in bulk

- `POST /email-receipts/process-batch` `{ domain?, statuses?, limit?, since? }` runs the
  pipeline over up to `limit` (default 100, at most 200) stored emails, oldest first, one
  after the other, each in its own transaction, and answers `{ processed, byOutcome,
  failed, remaining, since }`. The default statuses are the ones the pipeline can run
  again (`pending`, `no_parser`, `parse_failed`, `unmatched`, `ambiguous`,
  `review_conflict`); a `review` email stands behind a proposal and is never taken. The
  run ends because of `since`: the first call stamps the database clock, and every call
  selects only emails whose `updated_at` is before it. The pipeline touches the row it
  processes, and a failure touches it too, so every email is taken at most once per run
  and `remaining` (the matching emails still before `since`) reaches 0. The client
  loops until `remaining` is 0, a call touches nothing, the person cancels or a call
  fails. There is no new lock: each email is processed under its own row lock, as a
  reprocess is, and a concurrent poll that reaches the same email serializes on it.
- `GET /email-receipts/overview` answers the Overview cards in one statement (the
  mailbox's state, the emails by status, how many "Process all" would run, the proposals
  waiting, the approved and draft profiles, and up to ten sender domains of `no_parser`
  emails no profile covers). It carries counts and names only, never email text.
  `GET /email-receipts/domains` gains `processable` per domain, so the post-approve dialog
  can name how many emails of the new profile's senders it would process.
- `POST /ai-review-requests/approve-batch` `{ ids }` (1 to 100 distinct ids) approves
  proposals the way a single approval does: for each id the card is rebuilt from the
  stored proposal against the transaction as it is now (`AiReviewWorkService.buildApprovalCard`),
  then `AiActionsService.confirm` is called, one transaction per request, so a refusal
  (a changed row, a reconciled lock, the write limit) leaves that request proposed and the
  others unaffected. The answer lists, per id, `ok` or the reason. Nothing is approved
  that the same person could not approve one by one, and the daily limit counts each one.
  The service and controller live in the AI module (the receipts module imports it, not
  the reverse).
- `POST /email-receipts/profile-batch` `{ parserId, action, after? }` counts, ignores or
  deletes the stored emails a profile matches (`EmailReceiptProfileBatchService`). An
  email matches when the pipeline would give it to the profile: `chooseReceiptParser`
  over the user's approved profiles (`loadApprovedParsers`) with this one among them as
  approved (a draft is asked about as it would read once approved), so the sender
  domain, the subject words, the ranking against the other profiles and `requireLine`
  all count, and an email another profile of the same domain reads is never touched.
  The scan walks the profile's sender-domain emails (`DOMAIN_MATCH_SQL`) in id order,
  100 per call, and answers `{ matched, applied, unreadable, ignored, done, next }`; the
  client loops with `after = next` until `next` is null, so each email is looked at once
  whatever the action does to it. `count` writes nothing (the client confirms with the
  totals first). It backs the offer a profile with `discard` makes when it is saved or
  approved: the stored emails it matches are ignored or deleted as new ones will be. Each email is ignored or deleted in its own transaction under its row
  lock, with the single action's steps (`backend/src/email-receipts/receipts/receipt-disposal.ts`) and its state read
  again there: an email whose proposal was applied is kept by both actions, one that could
  not be read (`skipped`) is kept by `ignore` (the single action refuses it) and deleted
  by `delete`. A deleted email is not fetched again: the mailbox cursor is past it.

## 9. Frontend

- `/email-receipts` is a hub with the tabs Overview, Emails, Profiles and Mailbox
  (`?tab=`; a link with `?domain=` and no tab opens Emails; a tab is mounted when first
  opened). `/settings/email-receipts` redirects to `?tab=mailbox`, the settings page keeps
  a card that links to the hub, and the OAuth callback (its path is the redirect URI
  registered with the providers and is unchanged) returns to `?tab=mailbox`. The Overview
  shows the cards of `GET /email-receipts/overview` and, until a mailbox is connected, an
  email is stored and a profile is approved, a four-step wizard (connect a mailbox, fetch
  emails, create a profile, review proposals). Emails has "Process all (N)" (the filtered
  sender's emails, or all), a confirmation, progress with Cancel and a summary of where the
  emails ended; approving a profile offers "Process the N stored emails from <domains>
  now?" when any are waiting. Profiles and Mailbox are the sections that were on
  `/settings/email-receipts`; the profile editor gains the Matching and Proposal fieldsets
  (5.4 to 5.6) and the mailbox settings the AI-limit switch (7.1). The demo account gets
  the explanation on Profiles and Mailbox.
- The mailbox section of the hub: "Connect with Google" / "Connect with Microsoft"
  (only for a provider the operator configured) or the manual mailbox form
  (write-only password, test
  connection, poll now, AI mode, auto-apply, last poll and last error), and the
  parsers list with an editor (name, domains, subject words, payee, patterns
  one per line, section markers, category rules, default and shipping
  category, a "Lines source" select: Text or HTML), a test panel against a stored
  receipt, approve and delete.
  The editor has a "Form | JSON" switch at the top. The form shows only what it
  can hold without loss (plain line patterns, `startAfter` / `stopAt`, item
  patterns, category rules with a default and shipping category); a definition
  that uses anything else (labelled entries, `paid`, `payee`, block or single
  items, `joinWrapped`, line guards, a rule `field`, an unknown key) opens in
  the JSON mode, a monospace box validated by the server on save, and the form
  switch stays off for it with the reason; a definition the form can show can
  switch both ways, and saving it from the form writes version 2. The list has a
  "View JSON" row action for every parser (draft or approved, valid or not): a
  read-only dialog with the pretty-printed stored definition and a Copy button.
  The test panel works in both modes and lists under "Matched by" which entry
  and line read each value (design 5.1, the test trace), and says when a guard
  would stop the pipeline reading the email.
- `/email-receipts` (Tools menu, owner only): a state filter and a sender-domain
  filter (a select of "All senders" and each domain with its count, kept in
  `?domain=`; `GET /email-receipts?domain=` matches the receipt's own, post
  forward-detection `from_domain` exactly or as a sub-domain, with `%`, `_` and
  `\` taken literally, combined with `status`; `GET /email-receipts/domains`
  lists the user's domains with counts, at most 200, declared before `:id`; a
  list belongs to the pair of filters that asked for it, and the counts are read
  again after every command), the receipts table with state
  badges and actions (a checkbox column selects any number of emails; the selection
  bar offers Delete, Ignore and "Prepare a profile with AI (N)", which is on only
  for one to 25 emails (five per sender, five senders) and says beside it why it is off, see "Bulk
  actions" below; the row's own "Draft parser with AI" is the inline action of an
  email no parser read and "Create parser" is in the menu); a detail dialog with the email (HTML in the sandboxed frame by
  default, an HTML / Text / Lines toggle, the note "Remote images are not
  loaded.", who forwarded it and the shop's date), the parsed result, a
  "Structured data (schema.org)" section (found, with the order and its lines, or
  not found), a "Read from structured data" badge on a reading that came from it,
  and the candidates. The Lines view lists the numbered lines of the Text or the
  HTML source (`GET /email-receipts/:id` returns `lines: { text, html }`, `html`
  null without an HTML part, and `structuredOrder`; the list never does), which
  are exactly what a pattern is matched against. The
  transaction picker's From and To dates are editable (they start as the window
  around the purchase date; the server accepts any linkable transaction of the
  user whatever its date) and its empty message says the dates can be widened.
- **Bulk actions** on the Emails list: `POST /email-receipts/bulk`
  `{ action: 'delete' | 'ignore', ids | filter, expectedCount }` answers
  `{ affected, skippedLinked, unchanged, notIgnorable }`. Exactly one of `ids`
  (1 to 500 UUIDs) and `filter` (`{ status?, domain? }`, read by the same predicate as
  the list, so a domain includes its sub-domains) names the emails; a filter acts on
  at most 20,000 emails (more is a 400 asking to narrow it). The header checkbox
  selects every row of the page; when more emails match the filter, "Select all N
  matching this filter" (N from `GET /email-receipts/status-counts`, the number the
  state buttons read) sends the filter instead of ids. A confirmation states the count
  and the filter ("Delete 1,234 emails from gmail.com? This cannot be undone.") and
  points to Ignore, which keeps the emails. The server locks the matching rows
  (`FOR UPDATE`, ascending id) in ONE transaction and compares their number with
  `expectedCount` before it writes anything: a different number is a 409 with
  `currentCount`, the dialog shows the new number and asks again, and nothing was
  changed. Only then are the open review requests of those emails dismissed and one
  `DELETE` or `UPDATE ... WHERE id = ANY(...) AND user_id = ...` written. An email
  linked to a transaction is never deleted or ignored in bulk (`skippedLinked`).
  Ignore follows the single `ignore()` rules: an already ignored email is `unchanged`;
  a `skipped` email or one whose proposal was applied is `notIgnorable`. The route is
  owner-only like the others and throttled to 10 a minute. "Prepare a profile with AI"
  stays limited to one to 25 emails (five per sender, five senders) and never works on a filter.
  The filter also takes `excludeStatuses`, `excludeDomains`, `receivedFrom` and
  `receivedTo`, and `POST /email-receipts/bulk/count`, `bulk/reprocess` and
  `bulk/approvable` act on the same selection (`receiptSelectionClause`).
- `/ai-reviews`: an `email_receipt` row shows the sender and subject instead of
  the rule name, and a `pending` one says it waits for an AI agent (with a link
  to the AI settings). An `email_parser_draft` row reads "Parser draft from N
  emails (domain)", says the same while `pending`, and once `proposed` says "Draft
  parser ready" with a link to `/email-receipts?tab=profiles` where it is tested and
  approved; it has no card and no transaction, and can be dismissed. A column of
  checkboxes selects the proposals that can be approved (`proposed`, with a card);
  "Approve selected (N)" and "Approve all shown (M)" ask once and call
  `approve-batch` in chunks of 100, then show how many were applied and, for each that
  was not, why. A kind filter (All, Email receipts, Rules; `?kind=`) narrows the list.
- `/ai`: "Recognize with AI" opens the chat with the order email attached as
  `order-email-YYYY-MM-DD.txt` and the message typed in the composer
  (`/ai?handoff=<id>`, `lib/ai-chat-handoff.ts`: in memory, one entry per id,
  discarded once staged); nothing is sent until the user presses Send.

## 10. Test matrix

| Layer | Suite | Proves |
|---|---|---|
| Unit | `parsing/*.spec.ts` | Amount grammar, item section, captures, bounds, `complete` truth table; priority by order, labelled entries and their `within` edges, block items, `skipLines`, resync after a failed record; `paid` arithmetic, `single`, `joinWrapped`, literal asterisk and trimming, `payee`, category rule fields, line guards, the trace; the Allegro, PayU, Google Play and Amazon mails read complete |
| Unit | `matching/*.spec.ts` | Every row of the match truth table (spec section 3) |
| Unit | `proposal/*.spec.ts` | Signs, single line vs split, shipping and discount lines, description cap |
| Unit | `imap/*.spec.ts` | Read-only options, egress lookup passed, IP literal refused, source scan of write calls |
| Unit | services | Lease, cursor, rematch window, auto-apply gate, AI modes, owner-only |
| Integration | `email-receipts.integration.spec.ts` | Ingestion idempotency on the unique key; RLS isolation of the three tables; the widened kind CHECK |
| Frontend | components | Settings form never shows the password; states and actions; inbox row for the new kinds; the sandboxed HTML frame (empty `sandbox`, the policy meta first, never the page's DOM); the picker's editable range; the selection bar and both outcomes of drafting (chat opened, queued) |
| Unit | `imap/html-lines.util.spec.ts` | Block elements and every table cell end a line, nested tables, a wrapped product name stays one line, the Gmail forward wrapper, links and images, entities, NBSP, hidden elements, malformed and hostile HTML (depth, size, line cap), JSON-LD and microdata collection and their caps |
| Unit | `parsing/schema-org-order.spec.ts` | Google's Gmail Order shape, Invoice, `@graph`, type arrays and prefixes, number vs string prices, microdata with nested OrderItems, malformed JSON, depth and node caps, other types ignored, the receipt built from the order |
| Unit | `pipeline/receipt-source-lines.spec.ts`, `pipeline/email-receipt-pipeline.service.spec.ts` | The source a definition chooses, `no_html`, precedence (a parser that read a total wins; schema.org with no parser or no total; unusable markup falls through), the reason slot, no auto-apply |
| Integration | `email-receipts-pipeline.integration.spec.ts` | A real JSON-LD order with no parser ends in review with source `schema_org`; an html parser reads the stored HTML; `no_html` |
| Unit | `imap/forwarded-message.spec.ts` | Every client's header block, every date format and label language, bounds and linearity on hostile text |
| Unit | `parsers/email-receipt-parser-tools.service.spec.ts` | `test` writes nothing, `save_draft` writes a draft only, claim and ownership checks before the write |
| Integration | `email-receipts-pipeline.integration.spec.ts` | A forwarded email read by the shop's parser and matched on the purchase day; draft request, claim by id, tests, draft, proposed, approve, applied; another user sees none of it |

## 10a. Matching and profile follow-up (PR 1497)

Done: visible effective `match`, `fees`, `joinWrapped` fallback, `balanceTolerance`, categories by name, category history, status counts and per-state sender domains, a card-dependent main action (Approve through the review inbox's `approve-batch` route), the profile creation guide, and "profile" wording in the UI (spec section 3b).

Not done: after approval, attach the PDFs of the email to the transaction and link the source email. Emails keep no attachment bytes (neither the IMAP client nor `email_receipts` stores them), and the link needs a new column (for example `source_email_receipt_id` on the transaction), so it needs a migration, a fetch of the PDFs from IMAP through `shardedSegments`, and a change in `ai/actions`. It is a separate proposal.

## 11. Deliberately left for later

- Receipt photos and PDF attachments (vision or OCR, then the same parser).
- Several mailboxes per user; a per-parser currency; tolerance for an amount
  that differs by an FX conversion.
- Backing up mailboxes (credentials) and receipts.

## 12. Open questions for the maintainer

- **Q1.** Is the review inbox the right queue, or should receipts have their
  own proposal store? (This branch reuses the inbox.)
- **Q2.** Should auto-apply exist at all, given INV-RULE-001's "never committed
  without a human approval" for AI proposals? (It is limited here to a
  deterministic, user-approved parser and a single strong match.)
- **Q3.** Retention: should stored email text be purged after N days?
