# Email receipts: trade confirmations create investment transactions

Companion to [`email-receipts.md`](../future-plans/email-receipts.md) (the feature this extends)
and `docs/financial-semantics.md` (how an investment transaction is booked).

This extension shipped: it landed on `main` in PR #1497 (2026-10-09), with
the migration `database/migrations/20261015170000_email_receipt_trades.sql`.
The plan is retired and this document is kept as the specification the code
is held to.

## 1. Goal

A brokerage emails "Your order has been filled" for every trade. Today the
Email Receipts feature cannot read it: it enriches a bank transaction that
already exists (split, category, payee), and a trade has no such transaction;
the trade itself is what is missing from the ledger. This extension reads the
confirmation with a saved profile and proposes the **investment transaction to
create**: account, buy or sell, security, shares, executed total, date. A person
approves it in the review inbox like any other proposal; an opt-in switch can
apply it unattended, under a stricter gate than a receipt's.

Cash dividends and reinvested dividends are read too, as `DIVIDEND` and
`REINVEST` rows: [`docs/specs/email-receipt-dividend-trades.md`](../specs/email-receipt-dividend-trades.md).
Out of scope: splits, transfers, option and crypto confirmations; several fills
in one email. A trade profile is written in the profile editor's form (a kind switch
shows the trade fields, the account rules with their currency and the
currency markers), in its JSON mode, by the wizard or by the assistant.

## 2. Decisions

1. **A profile with a `trade` section is a trade profile.** The section holds the
   fields below and the profile holds nothing else of a receipt's (`trade_conflict`
   from the validator), so one email is never both. `requireLine`, `skipIfLine`,
   `waitIfLine` and `source` still apply.
2. **The proposal is a new queue kind, `email_trade`.** It has no transaction (there
   is none yet) and carries the email (`email_receipt_id`). It is born claimed by
   the receipts module's own key, `email-receipts`, so an agent never sees it
   pending. Its proposal is the signed `create_investment_transaction` card the
   chat's investment tool builds, carrying the request's id so confirm marks the
   request applied in the write's own transaction.
3. **The executed total is the fact; the price follows it** (INV-TRADE-001). The
   proposal carries quantity and total, never a price: the same preview that the
   chat uses derives the price at the column's ten decimals. The email's average
   price is only a cross-check.
4. **The account comes from the profile**: `accountRules` map the account text the
   email prints (`Account: RRSP`) to the user's open brokerage account, with a
   `defaultAccountId` for emails that print no account (text the rules do not
   know is no account, never the default). Every account id is checked when the
   profile is tested and saved. The security is found by ticker among the user's
   own active securities, strictly (the ticker, or the ticker plus an exchange
   suffix: `XCNS` finds `XCNS.TO`), never by name or fragment, and never by a
   guess between several; an exact symbol wins only over listings in its own
   currency, else the one the account already trades decides. An email whose
   amounts name a currency other than the security's is refused. Two accounts
   the email prints alike (an RRSP in CAD and one in USD) are told apart by the
   trade's currency (section 3.2), never by a guess.
5. **A trade already in the ledger is not proposed again.** The same account,
   direction, security, day and exact share count (VOID rows ignored), on a row
   no other email accounts for (`email_receipts.investment_transaction_id`),
   makes the email `ignored` with `status_reason` `trade_exists`, and the email
   then accounts for that row. A matching row another email already accounts for
   is a second identical fill: proposed, never auto-applied. The same check
   refuses an agent's card and the inbox's rebuild, and runs again inside the
   confirm, under the holdings lock.
6. **Auto-apply is the mailbox's existing switch, with a stricter gate** (section 5).
7. **A trade that pays a scheduled bill or deposit marks it paid** (section 4.1).
8. **A trade email is linked to the transaction it reports, not to a bank
   transaction** (section 4.2), and can be recognized by the AI (section 4.3).

## 3. The profile section

```json
{
  "version": 2,
  "requireLine": ["Your order has been filled"],
  "trade": {
    "account":  ["Account: {account}"],
    "action":   ["Type: {action}"],
    "symbol":   ["Symbol: {symbol}"],
    "quantity": ["Shares: {quantity}"],
    "price":    ["Average price: {amount}"],
    "total":    ["Total cost: {amount}"],
    "date":     ["Time: {date}"],
    "accountRules": [
      { "match": "RRSP", "accountId": "<uuid of the RRSP investment account>" },
      { "match": "TFSA", "accountId": "<uuid of the TFSA investment account>" }
    ]
  }
}
```

Every field is a list of entries read exactly like a receipt field (a line
pattern or a labelled `{label, value, within}`, tried in array order, rule globs
only). The capture each takes: `action`, `symbol`, `quantity`, `date`, `account`;
`total`, `price`, `commission` take `{amount}`.

| Field | Required | Meaning |
|---|---|---|
| `action` | yes | Text that names the direction: a word `buy`/`bought`/`achat` or `sell`/`sold`/`vente`/`vendu` (case-insensitive); both or neither is no reading. A reinvestment word (`reinvest`, `drip`, `réinvesti`...) reads `REINVEST`, else a dividend word (`dividend`, `distribution`, `dividende`) reads `DIVIDEND` (the dividend spec) |
| `symbol` | yes | The ticker as the broker prints it |
| `quantity` | no; a buy, a sell or a reinvestment reads none without it (`trade_no_quantity`) | Shares, at most 8 decimals, in either decimal convention (`75.9878`, `75,9878`, `1,234.5`, `1.234,5`); a `,` followed by exactly three digits groups thousands |
| `total` or `price` | one of them | The executed total (commission included for a buy), or the average price per share (up to 8 decimals); a sign or parentheses on a total are dropped (a debit is still the total) |
| `commission` | no | Commission; a buy's total includes it, a sell's proceeds are net of it |
| `date` | no | `YYYY-MM-DD` (also of an ISO timestamp, or `YYYY/MM/DD`), `Month D, YYYY` or `D Month YYYY` in English or French, or a numeric day and month only when which is the day is certain; time and zone are ignored (the broker's own day). Without it, the day the email was sent (the shop's day for a forward) in the user's timezone |
| `account` + `accountRules` | one of `accountRules` or `defaultAccountId` | The account text and the rules that map it (first match wins); a rule may name a `currency` (section 3.2) |
| `currencyMarkers` | no | `[{match, currency}]`: a capture-free glob tried on every line, and the 3-letter currency it names (section 3.2) |

Bounds: the receipt parser's (200 characters a pattern, 10 entries a field), at
most 20 `accountRules` and 20 `currencyMarkers`. The validator's new codes: `trade_conflict` (a receipt
field beside `trade`), `trade_amount_missing` (neither `total` nor `price`),
`trade_account_missing` (no way to decide the account), `invalid_currency` (a
rule's or a marker's `currency` that is not a 3-letter upper-case code); plus the existing
`empty`, `invalid_uuid`, `capture_not_allowed` and `unknown_key` at the
`trade.*` paths.

### 3.1 Reading and completeness

`complete` is true only when the action, symbol, quantity (none for a cash
dividend) and an amount were read and an account was decided. The first missing thing is the reason
(`trade_no_action`, `trade_no_symbol`, `trade_no_quantity`, `trade_no_amount`,
`trade_no_account`, `trade_no_currency`), and the email is `parse_failed` with it.

`consistent` cross-checks the email against itself when it states a price and a
total. With `q` shares, a price written with `d` decimals, a total `T` and a
commission `c`, the gross is `T - c` for a buy and `T + c` for a sell, and the
reading is consistent when

    | q * price - gross |  <=  q * 0.5 * 10^-d  +  0.01

(price rounding plus one cent), in integer arithmetic (shares and the price in
1e-8 units as BigInts, money in 1/10000). Numbers are read with the trade grammar
(`parsing/trade-number.ts`), not the receipt amount grammar, which reads a third
decimal as a thousand group. `consistent` is `null` when the email states no price
or no total: nothing to check.

Numerical example (the email in the fixture
`backend/src/email-receipts/parsing/fixtures/wealthsimple-trade.ts`): 75.9878
shares at $26.32 is 1999.998896 against a stated total of 2000.00. The
difference, 0.0011, is inside `75.9878 * 0.005 + 0.01 = 0.39`, so the reading is
consistent. A price of $31.00 gives 2355.62: inconsistent.

An email that states only a price is proposed with the total that price implies,
to the ledger's four decimals (`75.9878 * 26.32 = 1999.9989`); it is never
`consistent` and so never auto-applies.

### 3.2 Accounts the email prints alike: the trade's currency

A broker may print the same account text for two accounts that differ only in
currency (Wealthsimple's "Account: RRSP" for a CAD and a USD RRSP). An account
rule may then name a `currency`:

```json
"accountRules": [
  { "match": "RRSP", "currency": "USD", "accountId": "<USD RRSP>" },
  { "match": "RRSP", "currency": "CAD", "accountId": "<CAD RRSP>" }
],
"currencyMarkers": [{ "match": "*U.S. dollars*", "currency": "USD" }]
```

The trade's currency is, in order: the currency the total (else the price)
names (a code, `US$`, `C$`/`CA$`/`CDN$`, `A$`, `NZ$`, `HK$`, `€`, `£`, `¥`; a
bare `$` names none); else the first `currencyMarkers` entry whose glob matches
any line; else, only when a rule needs it, the currency of the user's security
for the ticker, when all its listings share one (`readTradeEmail`,
`backend/src/email-receipts/pipeline/trade-reading.ts`, the one reading behind
the pipeline, the test and the preview). `currencySource` on the reading says
which (`amount`, `marker`, `security`).

Rules are tried in array order. A rule whose glob matches and that names no
currency applies; one that names the trade's currency applies; one that names
another is skipped; one that names a currency while the trade's is unknown
stops the search with no account and the reason `trade_no_currency`, never a
guess. With no account text the rules are tried against the empty text, so a
`*` rule (one per currency) maps emails that print no account. An email-read
currency also narrows the ticker's listings (`SHOP` in USD beside `SHOP.TO` in
CAD), and the card still refuses a currency the security does not trade in.

Truth table (rules as above, a TFSA rule with no currency after them):

| Account text | Email currency | Security currency | Account | Reason |
|---|---|---|---|---|
| RRSP | USD (`US$2,000.00`) | any | USD RRSP | |
| RRSP | none, marker "U.S. dollars" hits | any | USD RRSP | |
| RRSP | none | CAD (one listing) | CAD RRSP | |
| RRSP | none | listings in CAD and USD | none | `trade_no_currency` |
| RRSP | EUR | any | none | `trade_no_account` |
| TFSA | none | unknown | TFSA | |

## 4. Pipeline

```
poll/process -> choose parser (as before)
             -> the parser has `trade`:
                  read the lines            -> incomplete: parse_failed (reason)
                  already booked            -> ignored (trade_exists), the email
                                               accounts for that row
                  close the email's open requests, queue an email_trade request
                  submit the card           -> refused: review + proposal_refused,
                                               request rejected with the reason
                                            -> stored: review, request proposed
                  opt-in gate               -> confirm the same card
```

The refusals the card build can raise (and the proposal then shows): the account
is not the user's INVESTMENT account; the ticker is none of the user's securities
or is ambiguous; the position cannot cover a sell. They are raised at proposal
time and again whenever the inbox rebuilds the card, so a stale proposal says why
it can no longer be applied instead of failing the list.

`email_receipts.trade` (JSONB, nullable) stores the reading; `parsed` is null
for a trade email. `email_receipts.investment_transaction_id` is the ledger row
the email accounts for (booked by its approval, linked, or `trade_exists`); an
email that accounts for a row is not read again or linked again. No automatic
pass (the poll's rematch, a bulk run) re-reads a trade email whose request is
open or dismissed: the proposal is the person's to approve, and a dismissal
stands. A bank-transaction link on an email a trade profile now reads is refused. The receipts page shows the reading in the detail dialog; the
review inbox shows the row as "Buy N shares of SYMBOL" with the card.

### 4.1 A scheduled bill or deposit the trade pays

When the card is built, `ScheduledTransactionsService.findInvestmentOccurrenceForTrade`
looks for the one active scheduled investment transaction of the same account,
direction and security whose next occurrence is due within less than half its
cycle of the trade's day (at most 7 days; a daily schedule its own day only), so
the occurrence after the one a trade paid is never taken for it, and whose
commission equals the trade's. Exactly one, or none: with two, which
bill the trade paid is a guess, and a guess marks the wrong one paid.

A match is part of the signed card (`scheduledTransactionId`, the due date the
card was built for, and the schedule's name on the card). Approving it does NOT
create a second row: confirm posts that occurrence through
`ScheduledTransactionsService.post` with the card's figures (date, shares, the
executed total and the exchange rate the card showed, description), inside the
one transaction that also marks the request applied (`beforeWrite`) and records
the row on the email (`afterInvestmentWrite`). The card is previewed with the
schedule's own funding account, which is where the post settles. The post creates the investment
transaction exactly as the schedule would, claims the occurrence and advances the
schedule. A schedule that moved on since the card was built refuses with a
conflict and nothing is written. The card is rebuilt on every inbox read, so it
shows the schedule as it is now; a card whose occurrence was posted or moved
since it was proposed is not approvable (link the email instead).

### 4.2 Linking a trade email

A trade email is not matched to a bank transaction, so "Link" means "this email
is that existing transaction". The detail dialog lists the user's own non-VOID
investment transactions of the trade's account, direction and ticker within 7
days of its day that no other email accounts for
(`EmailReceiptTradeLinkService.candidates`); linking one closes the email as
`ignored` with `status_reason` `trade_linked`, records the row on the email
(once: a linked email is not linked again), dismisses its open request
and, when a scheduled bill or deposit that trade pays is not yet paid (the matching
rule of 4.1, applied to the linked transaction's own figures), marks the occurrence
paid with `ScheduledTransactionsService.post(..., { recordOnly: true })`: the
occurrence is claimed and the schedule advances, and no money is written, because
the payment is already in the ledger. All in one transaction. An occurrence paid in
the meantime is not an error. Linking is allowed from `ignored` (an email closed as
`trade_exists`), which is when it matters most, but not once the proposal was
applied.

### 4.3 Recognize as a trade with AI

An email no profile read as a trade (or one whose proposal was refused) can be
sent to the assistant as a trade: `POST /email-receipts/:id/ask-ai` with
`{ asTrade: true }` queues a `pending` request of kind `email_trade` (no
transaction; `RECEIPT_TRADE_CHAT_INSTRUCTION`), and the receipts page stages the
chat with the email attached. The assistant claims it by id (the claim returns the
email and no transaction) and answers with `ai_review_requests` `submit` and the
`trade` field: `accountName` (an investment account), `action`, `symbol`,
`quantity`, `totalAmount`, optional `commission`, `date` (else the email's day) and
`description`. The account is found by name; the rest goes through the same card
build as a profile's trade, so the same refusals apply, and a person approves the
card. `submit` accepts the `trade` field for this kind only, and refuses it for
any other; a request a profile queued is born claimed by the receipts key, so no
agent can answer it.

### 4.4 Profile tooling

- **Test and the assistant's tool.** `POST /email-receipt-parsers/test` and the
  `email_receipt_parsers` tool's `test` return, for a trade profile, `trade` (what
  it read, `complete`, `consistent`) and its trace, and no match. `categories`
  also returns `investmentAccounts` (id, name and currency) for `accountRules`; the language
  guide it returns teaches the trade section.
- **Preview.** A complete trade is the outcome `trade`; an incomplete one is
  `parse_failed` with the `trade_*` reason; each item carries `trade` (direction,
  ticker, shares, `consistent`). No bank transaction is looked up.
- **The wizard.** Step 1 has a switch "These are brokerage trade confirmations":
  the samples are emails alone (no transaction is paired), step 2 sends
  `{ kind: "trade", tradeReceiptIds }` to `POST /email-receipt-parsers/generate-with-ai`
  (the prompt, or the queued instruction for the user's own agent, asks for a trade
  profile, with the account mapping), and step 3 previews as above. Changing the
  switch clears the ticked emails.

## 5. The auto-apply gate

The mailbox switch (`auto_apply`) applies a trade only when ALL hold: the switch
is on; the profile is `approved`; the reading is complete; `consistent` is
`true` (a price was stated and agrees with the shares and the total), or, for a
cash dividend only, `null` (`tradeMayAutoApply`, the dividend spec section 6); the card
was built (account and security resolved, preview valid); no trade of that
description exists, accounted for or not; the email is no forward
(`isForwardedReceipt`: the broker of a forward is what its text claims, and only
the owner's own forward is read as the broker's at all, A26-H02). It then calls the same `/ai/actions/confirm` a person's
approval calls. Anything else waits in the inbox. The daily AI write limit counts
a trade (the exemption of a profile's proposal applies to `update_transaction`
only).

## 6. Invariants

INV-RECEIPT-008 (`docs/system-invariants.md`): a trade confirmation creates an
investment transaction only through the review card and the confirm path. This is
the one exception to INV-RECEIPT-003's "never moves money", and it is bounded the
same way: signed card, single-use, expiry, the request marked applied in the
write's own transaction.

The duplicate check runs before the proposal and again inside the confirm,
under the holdings lock every investment write takes, so a manual entry or a
schedule's post of the same trade made between the proposal and its approval
refuses the approval (409). Two different emails reporting one fill (a forward
and the original) are told apart only by the row the first accounts for: the
second is proposed, never auto-applied, and the person approving sees both.

## 7. Test matrix

| Layer | What |
|---|---|
| Reader (`parse-trade.spec.ts`) | The Wealthsimple email; a sell; each incomplete reason; price-only and total-only; the consistency table; share-count, direction and date grammars |
| Validator (same file) | Valid profile; each new code; wrong capture; unknown key in a rule |
| Currency (`parse-trade.spec.ts`, `trade-reading.spec.ts`, `securities.service.spec.ts`) | Prefixed dollar signs; a marker and its trace; amounts before a marker; the security's currency only when a rule needs it, and none for listings in two currencies; a `*` rule without account text; `invalid_currency`; listings narrowed by the email's currency |
| Pipeline (`email-receipt-pipeline.service.spec.ts`, `email-receipt-trade.service.spec.ts`) | Branch to the trade service; no bank-transaction lookup; request closed when none is held; duplicate; conflict; refusal; each auto-apply gate condition, a forward included |
| Forwarded sender (`test/integration/email-receipts-forwarded-sender.integration.spec.ts`) | An outside sender's pasted "Forwarded message" block books nothing (BUY 10 AAPL, the cash stays 10 000.00); the owner's forward is proposed, never auto-applied; the broker's own email auto-applies through the real poll, card and confirm |
| Queue (`ai-review-requests.service.spec.ts`) | `enqueueTrade` conflict clause; `markTradeApplied` predicate and 409 |
| Card (`ai-review-work.service.spec.ts`) | Strict ticker; total passed as the fact, no price; refusals; inbox rebuild; approval; agents cannot answer the kind |
| Confirm (`ai-actions.service.spec.ts`, `investment-transactions.service.spec.ts`) | The hook runs first, on the write's manager; a refusal writes nothing; a card that pays a schedule posts the schedule instead of creating a row |
| Schedule (`scheduled-transactions.service.spec.ts`) | The matching query's predicates, none and ambiguous; `beforeWrite` runs inside the post and a refusal writes nothing |
| Link and recognize (`email-receipt-trade-link.service.spec.ts`, `email-receipt-ai.service.spec.ts`, `ai-review-work.service.spec.ts`) | Candidates; link closes the email, marks the schedule paid with no money, tolerates a paid-in-the-meantime conflict; the trade request queued pending; an agent's trade, account by name, date fallback |
| Tooling (`email-receipt-parser-tools.service.spec.ts`, `email-receipt-parser-preview.service.spec.ts`, `email-receipt-parser-generate.service.spec.ts`, `parser-generate-prompt.spec.ts`) | Trade test result and `investmentAccounts`; the `trade` preview outcome; the trade generate request |

Not covered by a unit test: the migration against a real PostgreSQL
(`scripts/verify-schema.sh`) and the integration suites, which need Docker.
The forwarded-sender suite is the one trade integration test: it gives the
harness's `ScheduledTransactionsService` stub `findInvestmentOccurrenceForTrade`.

## 8. Follow-ups

None.
