# Spec: email receipts, matching and proposal arithmetic

Status: **proposed, awaiting maintainer approval** (kenlasko/monize#930). The
design is [`../future-plans/email-receipts.md`](../future-plans/email-receipts.md).

Related: INV-RULE-001 (a proposal never moves money), INV-RECEIPT-001 to 006,
`docs/financial-semantics.md` section 5 (splits),
`docs/financial-calculation-contract.md` section 7 (rejection before write).

---

## 1. Units

Every amount the parser reads is a non-negative integer in 1/10000 units
(`12.99` is `129900`), the unit rule facts use (`rule-facts.ts`). Conversion to
a decimal happens once, when the proposal is built (`/ 10000`, then
`roundMoney`). No float is summed.

## 2. The amount grammar (`parseReceiptAmount(text)`)

Input is the text of one `{amount}` or `{price}` capture. Output is 1/10000
units or `null`.

1. Remove every character that is not a digit, `.`, `,`, `-`, `'` or a space.
   Currency symbols and codes (`$`, `zł`, `PLN`, `EUR`, `€`) go.
2. A leading `-` or a surrounding `( )` is refused (`null`): a receipt amount
   is a magnitude; a discount is its own field.
3. Remove spaces, non-breaking spaces and `'` (thousand separators).
4. The decimal separator is the last `.` or `,` when it is followed by exactly
   one or two digits and nothing else. Every other `.` or `,` is a thousand
   separator and must be followed by exactly three digits, else `null`.
5. No digits, more than 12 integer digits, or anything left over: `null`.

| Text | Result (units) |
|---|---|
| `12.99` | 129900 |
| `$1,234.56` | 12345600 |
| `1 234,56 zł` | 12345600 |
| `1.234,56 €` | 12345600 |
| `1,234` | 12340000 |
| `1234` | 12340000 |
| `12,5` | 125000 |
| `0.00` | 0 |
| `-5.00` | null |
| `1,23,4` | null |
| `abc` | null |

`qty` is a positive integer from 1 to 9999 written with digits only (a trailing
`x` or `pcs` is removed first); anything else makes the item line not match.

## 3. Matching (`matchReceipt`)

This section is the matching of a profile with no `match` section, which is the default of section 3a: the strategies `orderId`, `amount_payee`, `amount_date` in that order, a window of 3 days before and 14 after, an exact amount. A profile changes any of it in section 3a.

Candidates are the user's transactions, loaded in one query: not a transfer,
not VOID, not an investment row, in the currency of the account, dated from
`purchase_date - 3` to `purchase_date + 14` (calendar dates in UTC,
`addDaysYMD`), at most 200, newest first. A transaction that already has an
applied receipt, or an open receipt request, is not a candidate. An order
email describes a purchase, so only an expense (amount below zero) is a
candidate for an automatic match; income and a zero amount are not. A manual
link is not limited to expenses.

`purchase_date` is the date of the original message: `original_sent_at` when
the mailbox owner forwarded the receipt to the mailbox and the forwarded
header block was recognised (`imap/forwarded-message.ts`, applied at
ingestion and again on reprocess), otherwise `received_at`.

**A forwarded header block is honoured only for the owner's own forward**
(A26-H02): the outer From must be the mailbox login or the owner's verified
account email (`loadOwnAddresses`, read from the server's rows), compared
trimmed and lower-case; anybody else's pasted block is text, the email stays
that sender's, and a row another sender's block re-identified earlier is put
back under that sender on its next pass (`resolveForwardedIdentity`). A forward arrives
days after the purchase; centring the window on the arrival date would miss
the transaction. A forwarded date later than `received_at + 1 day` is not
believed and is dropped. The manual transaction picker uses the same date as
its default range and its From / To fields are editable; linking by hand or
by request accepts a transaction of any date.

Signals per candidate:

- **O**: the parsed order id (at least 4 characters) appears, case-insensitive,
  in the transaction's `description`, `payeeName` or `referenceNumber`.
- **A**: `abs(amount)` of an expense in units equals the amount the bank was charged,
  `paid ?? total`, exactly. With neither parsed, A is false for every candidate.
- **P**: the transaction's payee is the parser's payee (by id), OR the
  transaction's payee NAME is the merchant the email names (`ParsedReceipt.payee`),
  compared with `normalizePayeeName` (case, accents and legal suffixes ignored;
  an empty normalisation never matches). A payment gateway's notice names the
  merchant, whose bank line carries the merchant's name.

| Candidates with O | with A and P | with A only | Result | `match_kind` |
|---|---|---|---|---|
| exactly 1 | any | any | that one | `order_id` |
| 2 or more | any | any | ambiguous (the O set) | -- |
| 0 | exactly 1 | any | that one | `amount_payee` |
| 0 | 2 or more | any | ambiguous (the A and P set) | -- |
| 0 | 0 | exactly 1 | that one | `amount_date` (stored as `amount_only` before the profile configured matching) |
| 0 | 0 | 2 or more | ambiguous (the A set) | -- |
| 0 | 0 | 0 | unmatched | -- |

The candidate list stored on an ambiguous receipt is at most 10, closest date
first. A manual link sets `match_kind = manual`; the transaction must be the
user's, not a transfer and not VOID, checked in the transaction that stores the
link.

## 3a. Matching configured by the profile (`match`)

A profile's optional `match` section chooses the strategies, where a text signal is looked
for, the candidate window and the amount tolerance. Resolved once (`resolveMatchConfig`):
`by` default `orderId, amount_payee, amount_date`; `referenceIn` default `description,
payee, referenceNumber`; `daysBefore` 3 (0 to 60); `daysAfter` 14 (0 to 90); `amountTolerance`
`"0"` (`"0.00"` to `"5.00"`, digits with an optional point and at most four decimals, no
sign or exponent), held as integer units of 1/10000.

Signals per candidate, in addition to section 3:

- **R**: the parsed `reference` (at least 4 characters, trimmed) appears, case-insensitive, in
  the transaction fields named by `referenceIn`.
- **O**: as in section 3, but only in the fields named by `referenceIn`.
- **A**: `abs(abs(amount) - paid)` in units is at most the tolerance, where `paid` is
  `paid ?? total`. With neither parsed, A is false for every candidate. Integer units,
  never floats.
- **P**: as in section 3.

Strategies, tried in the order of `by`; the first that keeps exactly one candidate decides:

| Strategy | Keeps the candidates with | `match_kind` stored |
|---|---|---|
| `reference` | R | `reference` |
| `orderId` | O | `order_id` |
| `amount_payee` | A and P | `amount_payee` |
| `amount_date` | A | `amount_date` |

For each strategy: exactly one kept is a match (the later strategies are not run); two or
more kept is ambiguous with exactly those candidates (at most 10 stored, closest date first)
and the later strategies are not run; none kept passes to the next; none after the last is
unmatched. A strategy whose value is missing or shorter than 4 characters keeps none.
A candidate outside `purchase_date - daysBefore` to `purchase_date + daysAfter` is not
considered, whatever the strategy; the candidate loader reads that window, still at most
200 rows, newest first.

Validation: `by` is a non-empty list of the four names, each at most once (`duplicate_entry`),
and `reference` in `by` needs a `reference` field (`reference_field_missing`); `referenceIn`
likewise non-empty, from the three names, each once; the days are integers inside their
bounds and the tolerance a well-formed text inside its bound (`out_of_range`, `invalid_value`).

Numerical example. An email read `paid 49.99`, `reference ZX81-4477`, purchase date
2026-03-10; profile `by: [reference, amount_payee]`, tolerance `0.50`, window 3 before and
14 after (window 2026-03-07 to 2026-03-24). Candidates: T1 2026-03-12 `-50.40` "CARD
ZX81-4477", T2 2026-03-12 `-49.99` "CARD SHOP", T3 2026-02-20 `-49.99` "ZX81-4477".
T3 is outside the window. `reference` keeps T1 only (R): matched, `reference`, even though
T2 has the exact amount, and the attempts list `reference` with 1 kept; `amount_payee` is
not run. Without T1: `reference` keeps none, `amount_payee` keeps T2 if its payee is the
parser's payee. T1 as the only amount candidate would be kept by A (`|50.40 - 49.99| = 0.41
<= 0.50`) but T1's `-50.40` never auto-applies, because the gate requires the exact amount.

The test result carries the trace: the window, `considered`, the tolerance, the list of
attempts (strategy, kept count, at most 10 candidate transactions with date, amount and
payee) and the strategy that decided.

## 3b. Visible defaults, fees, balance tolerance and category sources

- **The effective `match`.** `effectiveMatchDefinition` (`backend/src/email-receipts/parsing/receipt-match-config.ts`) fills every default. A profile view, the profile form, the `email_receipt_parsers` tool result and every AI draft show it. Default strategy order: `reference` (only when the profile reads a `reference` field), `orderId`, `amount_payee`, `amount_date`.
- **`fees`.** A list of entries; each adds one fee (deposit, packaging, delivery), and the same line read by two entries counts once. Gross = items + shipping + fees. Each fee above zero is its own split line after shipping, in `feesCategory`; a fee without a category makes the proposal `items_uncategorized`.
- **`joinWrapped`.** The reader tries a buffer of 3, 2, 1 and then 0 previous lines, and the trace shows the lines actually used.
- **`balanceTolerance`.** A decimal text from `"0"` to `"0.05"`, compared in 1/10000 units. A difference inside it is added to the last split line so the splits sum to the transaction to the cent. A larger difference, or one that would change the sign of the last line, is refused as `amount_differs`.
- **Categories by name.** `defaultCategory`, `shippingCategory` and `feesCategory` hold a category name (`Parent: Child` allowed). The server resolves a name to the ID in the save transaction (case-insensitive; unknown or ambiguous is a 400) and the JSON view shows names, never IDs.
- **Item category sources, in order:** history (the same item name already approved with a category: `proposal/receipt-category-history.ts`), then the profile's `categoryRules` (an advanced option, not in the form), then the AI for the rest.

## 4. Completeness (`ParsedReceipt.complete`)

Let `gross = sum(items.amount) + shipping` and `net = gross - discount` (absent
shipping or discount is 0). `total` is the amount the email calls the total
(possibly a list price), `paid` the amount actually charged.

Checked in this order; the first that fails is the reason:

| # | Check | Fails with |
|---|---|---|
| 1 | at least one of `total` and `paid` was found | `no_total` |
| 2 | no item is left without an amount (an item with no `amount` or `price` takes `total ?? paid` when it is the only item) | `item_amount_missing` |
| 3 | at least one item | `no_items` |
| 4 | `net >= 0`, and `paid` (if found) `= net`, and `total` (if found) `= gross` or `= net` | `items_unbalanced` |
| 5 | every item categorised, and a discount above 0 has a category | `items_uncategorized` |
| 6 | shipping above 0 has a category | `shipping_uncategorized` |
| -- | all hold | complete, no reason |

Table rows (items 10.00, discount 3.00): `total 10.00` complete (gross);
`total 7.00` complete (net); `paid 7.00` complete; `paid 10.00` unbalanced;
`total 10.00, paid 7.00` complete (the promotion case); `total 8.00`
unbalanced; neither found: `no_total`. A discount above `gross` is unbalanced
whatever `total` says.

A discount needs a category only through the item it reduces: it is a line of
its own under `defaultCategoryId`, and without one the receipt is
`items_uncategorized`.

## 5. The proposal (`buildReceiptProposal`)

Let `T` be the transaction amount (signed, a decimal), `sign = T < 0 ? -1 : 1`,
and `E = paid ?? total`, the amount the bank was charged.

| Parse complete | `abs(T)` = E | Lines | Proposal |
|---|---|---|---|
| yes | yes | 1 (one item, no shipping, no discount) | `categoryName` of the item, `description` |
| yes | yes | 2 or more, summing (net) to `abs(T)` | `splits`: each item `sign * amount`, memo; shipping `sign * shipping`; discount `-sign * discount`; `description` |
| yes | yes | 2 or more, not summing to `abs(T)` | `description` only, reason `amount_differs` |
| yes | no | -- | `description` only, reason `amount_differs` |
| no | -- | -- | `description` only, reason from section 4 |

The split lines sum to `net`. When `paid` is stated, completeness proves
`net = paid = abs(T)`. When only `total` is stated and it equals `gross` while a
discount exists, `net` differs from `abs(T)`: the proposal never splits what
does not sum to the transaction, so it is description-only (`amount_differs`);
`AiReviewWorkService.submit` checks the sum again with `sumMoney`.

**Description summary**: `"{parser name} {orderId}: item1 x2, item2"`, items
in order, joined by `, `, `x qty` only when qty > 1; the whole summary is cut
to 300 characters with `...`. It is appended to an existing description with
` | ` (`composeDescription`, 750 cap); an existing description that already
contains the summary is left as it is and the proposal carries no description.

**Order number in the Ref #**: the order number goes in the transaction's
reference number, not the summary. The proposal sets `referenceNumber` when
the Ref # is empty; when the Ref # already holds the order number
(case-insensitive) it sets nothing and the summary still leaves it out. A Ref #
holding something else (a cheque or bank reference) is never overwritten, and
an order number over 100 characters cannot be stored there: in both cases the
order number stays in the summary. Every proposal kind carries it, a
description-only one included.

**Payee**: when the email names a merchant (`ParsedReceipt.payee`), `payeeName`
is that merchant when the transaction has no payee OR its payee is the parser's
own (the gateway, such as PayU); a transaction with another payee is left
alone. When the email names none, `payeeName` is the parser payee's name only
when the transaction has no payee.

### Numerical example

Receipt: `2 x USB-C cable 19.98`, `Phone case 15.00`, `Shipping: 4.99`,
`Discount: 2.00`, `Order total: 37.97`. Items 199800 + 150000, shipping 49900,
discount 20000: `S = 379700 = total`. Transaction `-37.97`.

Proposal splits: `-19.98` (cable, memo `USB-C cable x 2`), `-15.00` (case),
`-4.99` (shipping), `+2.00` (discount). Sum `-37.97`.

Same receipt, transaction `-35.00` (a partial capture): description only,
reason `amount_differs`.

A promotion (Google Play): item `24.99`, `Razem: 24.99` (total), a `-3.00`
promotion line (discount), `Visa-1234: 21,99 zł` (paid). `gross = 249900`,
`net = 219900`; `total = gross` and `paid = net`: complete. Transaction
`-21.99`: splits `-24.99` (item) and `+3.00` (discount), sum `-21.99`. A
transaction of `-24.99` is description only, reason `amount_differs` (`paid` is
`21.99`).

## 6. Missing-data policy

- No total: nothing is matched on amount; an order id may still match, and the
  proposal is description-only. The receipt page says the total was not found
  and names the parser.
- No parser for the domain: `no_parser`; the page offers "create parser" and,
  when AI mode is not `off`, "Draft parser with AI".
- A category id in a parser that was deleted: the proposal's validation refuses
  it, the fallback is description-only, and the page names the parser to fix.
- A mailbox error (DNS, TLS, login, folder): stored on the mailbox
  (`last_error`, 300 characters, log-safe) and shown on the settings screen; the
  cursor does not move.
- A receipt that is not text-decodable or above the size cap: `skipped` with
  the reason; its UID is still consumed.

## 7. Auto-apply gate

Applies only when every one holds: mailbox `auto_apply`; parser `approved`;
`complete`; `abs(T) = paid ?? total`; `match_kind` is `order_id`, `reference` or `amount_payee` (never `amount_date`, never a
match made with a tolerance that an exact amount would not make); the card was built; the receipt has no `joined` or `scaled` part (linked receipts spec section 7: a person approves every join); the email is no forward (`forwarded_by` is null, `isForwardedReceipt`): who sent a forward is what its text claims, so a person approves it, and the inbox card names the forwarder (A26-H02). Any refusal from `confirm` (write limit, reconciled lock, a
changed row) leaves the proposal waiting in the inbox.

## 7. (continued) Tag, categories by the AI, bulk work

**Tag.** A profile's `tag` (1 to 50 characters, no control character) is added to the
transaction by the proposal when, and only when, the proposal categorizes it (itemized
or one category); a description-only proposal has no tag. `confirm` finds the user's tag
by name case-insensitively or creates it, and adds the `transaction_tags` row in the
write's own transaction; existing tags stay. The card says "Tags: X (new)" when the tag
does not exist yet.

**Categories by the AI (`aiCategories`).** For an item no rule and no default category
covers, in a complete-otherwise reading of an approved profile:

| `aiCategories` | AI can answer now | Result |
|---|---|---|
| false | any | no call; the proposal is what the rules gave (description only when an item is uncategorized) |
| true | yes | one call; each valid choice sets the category with `categorySource: "ai"`; an invalid or missing choice leaves that item uncategorized |
| true | no | a request with the categorize instruction is queued; the proposal waits for an agent |

The poll's automatic step never calls the AI for categories; an email with every item
categorized by rules makes no call. A valid choice is an index of an uncategorized item
and an id of one of the user's own categories; anything else is dropped. The call is made
between two database transactions.

**Bulk processing.** `process-batch` selects emails with `status` in the requested
statuses (default: `pending`, `no_parser`, `parse_failed`, `unmatched`, `ambiguous`,
`review_conflict`) and `updated_at` before the run's `since`; each processed or failed email is
touched, so it is not selected again in the same run, and `remaining` is the count
still before `since`. A call with `limit` emails left returns `remaining` greater than 0
until the last. Example: 250 processable emails and `limit` 100 give `remaining` 150, then 50,
then 0; an email that raised an error is counted in `failed` and not retried by the run.

## 7a. AI extraction

When the poll's automatic step asks the AI about an email (`processAiRequest`),
the model returns the receipt's content, never a split of the transaction:

```json
{ "orderId": "A-1",
  "items": [ { "name": "Widget", "qty": 2, "amount": "19.98", "categoryId": "<id or null>" } ],
  "shipping": "4.99", "shippingCategoryId": "<id or null>",
  "discount": "2.00", "discountCategoryId": "<id or null>",
  "total": "37.97", "paid": "37.97", "description": "..." }
```

`paid` is optional: the amount actually charged, stated only when the email
shows it separately from the total (a card line after a promotion). It is read
like `total` and judged with section 4.

Bounds (`email-receipt-ai.schema.ts`, unknown keys refused): at most 100 items,
names 1 to 200 characters, `qty` an integer from 1 to 9999, `description` at
most 300 characters, order id at most 100. An amount is a JSON number or text.

AI output becomes a `ParsedReceipt` (`source: "ai"`, `buildAiParsedReceipt`) and
goes through the same rules as a parser's reading:

- **Amounts.** A number must be finite and not negative and is converted once with
  `Math.round(n * 10000)`; text goes through the amount grammar of section 2 and
  must hold nothing but the amount and a currency mark. An item whose amount does
  not convert, is zero, or whose name is empty is dropped; a total, shipping or
  discount that does not convert is read as not stated (`null`). Each is noted in
  the log. A stated `0.00` shipping is a known zero.
- **Categories.** An item's `categoryId`, and the optional `shippingCategoryId`
  and `discountCategoryId`, that are not one of the user's categories (the list
  given in the prompt) are `null`. The shipping and discount categories go into
  the `ParsedReceipt` as a parser's definition would give them, so a reading with
  shipping or a discount is `complete` only when each line that exists has a
  category (`shipping_uncategorized` / `items_uncategorized` otherwise).
- **Completeness** is the table of section 4, computed by the same function
  (`completeness` in `parse-receipt.ts`), not a copy of it.
- **The proposal** is `buildReceiptProposal` (section 5) with the transaction's
  amount, description and payee and the sender's domain as the summary's label,
  submitted through `AiReviewWorkService.submit` under the AI claim key. A
  description-only result (`amount_differs`, `items_uncategorized`, ...) is still
  submitted, and its reason is stored on the email (`status_reason`) so the email
  page names it. With no item to name, the model's own `description` is the
  description. A reading with no item, no total and no description is not an
  answer: the claim is given back.
- **Storage.** The reading is stored on the email (`parsed`, with `source: "ai"`)
  by one UPDATE conditional on the email still pointing at this request, so a
  slow answer never overwrites a newer one.

Which requests the automatic step takes: pending `email_receipt` requests whose
`instruction` is the poll's own (`RECEIPT_AUTOMATIC_AI_INSTRUCTION`), unclaimed
and never tried. A request queued by "Recognize with AI" carries a different
instruction (`RECEIPT_CHAT_INSTRUCTION`) and is never taken by the poll.

"Recognize with AI" (the button) does not call this: it queues a request and the
assistant in the chat, or an agent, answers it by id with splits, which
`submit` validates as in section 5 (the lines must add up to the transaction).

## 7b. Parser language (version 2)

The parser language is version 2 (design 5.1), the only one: the validator
refuses any other `version` (version 1 included) with `unsupported_version`.
What the parser reads is unchanged: a `ParsedReceipt` in units, judged by the
completeness table of section 4. What version 2 adds is HOW a value is found.

- **Priority by order.** The entries of `orderId`, `total`, `paid`, `shipping`,
  `discount` and `payee` are tried in array order, each over all lines; the
  first entry that finds an accepted value wins. A general `{amount} zł` entry
  is therefore read only when the specific entries before it found nothing.
- **Labelled entry** `{label, value, within}`: a line matching `label` (whole
  line, case-insensitive, no capture), then the first of the next `within`
  non-empty lines (1 to 10, default 3) whose `value` matches and holds an
  accepted value; otherwise the next label line. The Allegro total is
  `{label: "RAZEM", value: "{amount} zł"}`: the amount under the label, not the
  second figure under it (the basket without the Smart! package).
- **Accepted amount.** Section 2's grammar AND no operator character
  (`×`, `÷`, `+`, `*`, `/`, `=`, `%`, `<`, `>`, `@`, `#`, `\`, `|`): the grammar
  drops symbols, so `3 × 1,47 zł` would read as 31,47 and `10,95 + 5,00` as
  10 955,00. Punctuation a lazy capture drags along (`: 1 234,56 zł`) is still
  an amount.
- **Literal asterisk, trimming, invisible characters.** `{*}` and `\*` in a
  pattern are a literal `*`; every captured value is trimmed of whitespace, `*`
  and `_` (a bold `*149,41 PLN*` reads as `149,41 PLN`); zero-width characters,
  bidi marks and soft hyphens are removed from every line (Amazon puts U+202B
  before an order number).
- **Block items.** `skipLines` drop section lines; a `record` of 1 to 6 steps
  (each a glob, or up to 5 alternatives tried in order) is read from a cursor,
  one item per match (name, amount or price, optional qty from separate lines).
  The line total is `amount`, else `price * qty`; a failed record moves the
  cursor one line. `joinWrapped` (patterns) puts up to three unread lines in
  front of the next. `single` is one item for the whole email: its name from the
  first line the glob reads, quantity 1, amount `total ?? paid`.
- **An item with no amount** takes `total ?? paid` when it is the only item;
  otherwise it is dropped and the reason is `item_amount_missing`.
- **Payee and category rule fields.** `payee` entries read the merchant;
  `categoryRules[].field` is `item` (default), `payee` or `line`.
- **Lines source.** `source` (`text` by default, or `html`) chooses the lines
  every pattern, guard and trace number refers to; section 7c.
- **Line guards.** `requireLine` (the next parser for the sender is tried when
  no line matches; `no_parser` when none is left), `skipIfLine` (`ignored`,
  `status_reason` `skip_line`), `waitIfLine` (`unmatched`, `status_reason`
  `wait_line`, read again whole by the poll's 30-day rematch). Skip wins over
  wait; a manual link is not held back.
- **Roles and links.** `role` (`standalone`, `component`, `settlement`), the
  `linkKey` of a component, the `{link}` and `{instalment}` captures and the
  `link` section of a settlement tie several emails to one transaction; the
  rules and validation codes are in
  [`email-receipt-linked-receipts.md`](./email-receipt-linked-receipts.md).

Worked example (Allegro, three products, shipping 0,00): the items are
`3 × 1,47 = 4,41`, `3 × 2,50 = 7,50` and `26 × 1,94 = 50,44`; shipping is 0,00;
the total under `RAZEM` is 62,35; items plus shipping equal the total, so
`complete` is true. The second figure under `RAZEM` (73,30) and the Smart!
delivery price (10,95) are neither total nor shipping.

Worked example (Amazon): the mail names the product in `[image: ...]`, the
quantity `Ilość: 3`, the unit price `4799zł` (dropped by `skipLines: ["*zł"]`)
and `Suma 143.97zł`. One item of quantity 3 takes the total, 143,97: complete.

## 7c. Lines source and structured data

### Lines source

`ReceiptParserDefinition.source` is `"text"` (the default) or `"html"`
(anything else: `invalid_value` at `source`). Every pattern, guard and trace
line number of the definition refers to the lines of its source
(`ReceiptSourceLines.forSource`): `text` is `body_text` split on line breaks;
`html` is `htmlToReceiptLines(body_html)` (design 5.1, "Lines source"). Both go
through `normalizeLine`, are cut to 500 characters a line and 2,000 lines, and
number from 1 separately. A definition that reads `html` for an email with no
`body_html` reads nothing: the pipeline's `parse_failed` with `status_reason`
`no_html` (a parser of the sender that reads the text still applies first), the
test operation's `outcome` `no_html` with an empty reading.

### Structured data (schema.org `Order` and `Invoice`)

`extractSchemaOrgOrder(html)` reads the JSON-LD scripts (at most 50, 100 KB
each; invalid JSON ignored; depth 20, 2,000 nodes; objects, arrays and
`@graph` walked) and the microdata items (`itemscope`, `itemtype`, `itemprop`
nesting; depth 10, 200 items, 2,000 properties) of the HTML part, and keeps
the nodes whose `@type` / `itemtype` is `Order` or `Invoice` (a string or a
list, with or without the schema.org prefix; `OrderItem`, `OrderAction` and
every other type are ignored). JSON-LD readings come first, then microdata; the
first reading with a total and at least one item wins, else the first with any
content (shown on the email, used by nothing).

| `SchemaOrgOrder` field | Read from (first present) |
|---|---|
| `orderNumber` | `orderNumber`, `confirmationNumber` (text or number, at most 100 characters) |
| `seller` | `seller.name`, `merchant.name`, `provider.name`, `broker.name` (or the value as text) |
| `currency` | `priceCurrency` of the order, `totalPaymentDue`, `priceSpecification` or an offer; three letters, upper-case; display only |
| `orderDate` | `orderDate` as written; display only |
| `total` | `price`, `totalPrice`, `totalPaymentDue` (`.price`, else `.value`), `priceSpecification` (`.price`, else `.value`) |
| `discount` | `discount` |
| `items` (at most 100) | `acceptedOffer[]` when it yields any, else `orderedItem[]` |
| item `name` | `itemOffered.name`, `orderedItem.name` (a text value too), else the entry's own `name` |
| item `unitPrice` | the entry's `price` or `priceSpecification`, else the product's `price`, else its first `offers` entry's |
| item `qty` | `eligibleQuantity.value` (an offer) or `orderQuantity` (an order item): a whole number 1 to 9999, else 1 |
| item `amount` | `unitPrice * qty`; null when there is no unit price |

An amount in the markup is a machine number: a JSON number is converted once with
`Math.round(n * 10000)`; a string must be digits with an optional `.` and
digits (a fifth fraction digit rounds half up) and is converted without a
float. A negative, non-finite, huge, comma-decimal, symbol-bearing or
otherwise unreadable value is null: the Polish receipt grammar of section 2 is
NOT used here. Nothing is defaulted to `0` or `1`.

`schemaOrgToParsedReceipt(order, categoryId)` builds the `ParsedReceipt`
(`source: "schema_org"`): `orderId` = `orderNumber`, `total`, `payee` =
`seller`, `discount`, `paid` and `shipping` null, items from the order with
`categoryId` (and the discount line's category) = the default category of the
payee the seller resolves to through `PayeesService.resolveByName` (never
created; none: null). The only line without a unit price takes the order total
(as a parser's item does); with several lines, one without a price is
`item_amount_missing`. `complete` and `reason` come from `completeness` of
section 4, so an order whose lines plus its (unread) shipping make the total is
`items_unbalanced`, and a seller with no payee or no default category is
`items_uncategorized`: both are description-only proposals that say why.

Precedence for one email, in the pipeline:

| # | Condition | Reader | Outcome states |
|---|---|---|---|
| 1 | An approved parser applies and its reading has a `total` or a `paid` | the parser | as sections 3 to 5 |
| 2 | No parser applies, or the parser's reading has neither `total` nor `paid`, and the order states a total and at least one line | structured data | matched, proposed; `status_reason` `schema_org` unless the outcome has a reason of its own |
| 3 | Otherwise | none | `no_parser`, or the parser's `parse_failed` |

A structured reading never auto-applies (section 7 requires an approved
parser's complete reading). The match signal P compares the seller with the
transaction's payee name (`normalizePayeeName`), as for a gateway's merchant;
its proposal's summary is labelled by the sender's domain, as an AI reading's is.
A parser's `test` operation tests the parser only and is unchanged; the email's
detail shows what the markup says (`structuredOrder`, in 1/10000 units).

Inline-forwarded mail usually has lost the original's markup: a mail client
builds the forward as a new message and drops `<script>` and microdata; mail
auto-forwarded by a filter keeps the original body (Gmail does), so the
markup is read from that.

## 8. Test matrix

| Case | Suite |
|---|---|
| Every row of the amount table | `parsing/receipt-amount.spec.ts` |
| The lines of an HTML body: blocks and cells, nested tables, wrapped names, links, images, entities, NBSP, hidden elements, malformed and hostile input | `imap/html-lines.util.spec.ts` |
| The `source` key: accepted values, `invalid_value` for anything else; the lines a definition reads; `no_html` | `parsing/receipt-parser.validation.spec.ts`, `pipeline/receipt-source-lines.spec.ts`, `pipeline/email-receipt-pipeline.service.spec.ts`, `parsers/*.spec.ts` |
| Structured data: the field mapping table, machine amounts, Invoice, `@graph`, type forms, microdata, caps, other types ignored | `parsing/schema-org-order.spec.ts` |
| Precedence: the parser wins; schema.org with no parser; with a parser that read no total; not used without a total or a line; never auto-applied | `pipeline/email-receipt-pipeline.service.spec.ts`, `test/integration/email-receipts-pipeline.integration.spec.ts` |
| Item section bounds, `price * qty`, 100-item cap, 500-character lines | `parsing/parse-receipt.spec.ts` |
| Priority by array order (an earlier entry wins wherever it sits; subject before body per entry) | `parsing/parse-receipt.spec.ts`, `parsing/parse-receipt.labelled.spec.ts` |
| Labelled entries: the value under the label; `within` exactly and `within` + 1; the next label line when a window held nothing; whole-line, case-insensitive label; blank lines do not use up the window | `parsing/parse-receipt.labelled.spec.ts` |
| Block items: record with an optional step present and absent; resync after a failed record; `skipLines`; section bounds; `price * qty`; 100-item cap | `parsing/parse-receipt.block.spec.ts` |
| A quantity line or a sum is not an amount | `parsing/receipt-amount.spec.ts`, `parsing/parse-receipt.block.spec.ts` |
| The four Allegro mails read complete: totals 59,20, 62,35, 99,21, 400,00; shipping 0,00; the Smart! price and the second figure under RAZEM never total or shipping; ` x 8szt.` in a name is not a quantity | `parsing/parse-receipt.allegro.spec.ts` |
| Every validator code of the language, each at its path | `parsing/receipt-parser.validation.spec.ts` |
| The completeness table: `paid` and `total` rows, gross and net, a discount above gross | `parsing/parse-receipt.features.spec.ts`, `parsing/parse-receipt.spec.ts` |
| `items.single`, `joinWrapped` (cap of three held lines, cleared on an item), alternatives, an item without an amount (`item_amount_missing`) | `parsing/parse-receipt.features.spec.ts` |
| Literal asterisk, trimming of values, invisible characters | `parsing/parse-receipt.features.spec.ts`, `parsing/receipt-lines.spec.ts` |
| Payee field, `categoryRules[].field`, first rule wins | `parsing/parse-receipt.features.spec.ts` |
| The PayU, Google Play and Amazon mails (anonymised from real ones) read complete; the forwarded header of each; the VAT note and the unit price are never an amount | `parsing/parse-receipt.gateways.spec.ts` |
| Signal A by `paid ?? total`; signal P by the merchant's name | `matching/match-receipt.spec.ts` |
| Proposal against `paid ?? total`; the payee rule; a split that does not sum is description only | `proposal/build-receipt-proposal.spec.ts` |
| `requireLine` passes to the next parser, `skipIfLine` is `ignored`, `waitIfLine` is `unmatched` and is read again whole by the rematch | `pipeline/email-receipt-pipeline.service.spec.ts`, `pipeline/select-receipt-parser.rank.spec.ts` |
| The test result's `outcome` and `trace` (REST and tool) | `parsers/email-receipt-parsers.service.spec.ts`, `parsers/email-receipt-parser-tools.service.spec.ts` |
| Every row of the completeness table | `parsing/parse-receipt.spec.ts` |
| Every row of the match table; date window edges (day -3, day +14, day +15) | `matching/match-receipt.spec.ts` |
| Forwarded-header detection (Gmail, Outlook, Apple Mail, Thunderbird; English and Polish labels; date formats; the 200-line bound; no header means no result) | `imap/forwarded-message.spec.ts`, `imap/forwarded-receipt.spec.ts` |
| Only the owner's forward is re-identified: an outside sender's pasted block stays the sender's, an unverified account email is no owner's, an earlier forged row is put back; the owner's forward is proposed, never auto-applied, on the purchase and the trade path, and the inbox card names the forwarder (A26-H02) | `imap/forwarded-receipt.spec.ts`, `poll/email-receipt-poll.service.spec.ts`, `pipeline/email-receipt-pipeline.service.spec.ts`, `test/integration/email-receipts-forwarded-sender.integration.spec.ts` |
| A forwarded receipt matches the transaction near the original date, on ingestion and on reprocess; a manual link of any date | `test/integration/email-receipts-pipeline.integration.spec.ts` |
| Every row of the proposal table; the numerical example; description cap and duplicate | `proposal/build-receipt-proposal.spec.ts` |
| Auto-apply gate: each condition false in turn (and `reference`, `amount_date`, a forward) | `email-receipt-pipeline.service.spec.ts`, `pipeline/email-receipt-pipeline.profile.spec.ts` |
| Every strategy of section 3a, the order tried, the window edges per profile, the tolerance edges in integer units, R and O in the chosen fields only, a value shorter than 4 characters | `matching/match-receipt.profile.spec.ts`, `parsing/receipt-match-config.spec.ts` |
| The match trace: attempts stop at the deciding strategy, at most 10 candidates per attempt | `matching/match-trace.spec.ts` |
| Every validation code of `match`, `reference`, `tag`, `aiCategories` | `parsing/receipt-parser.validation.match.spec.ts`, `parsing/parse-receipt.reference.spec.ts` |
| Tag: find or create, additive, no tag on a description-only proposal | `tags/tags.service.names.spec.ts`, `proposal/build-receipt-proposal.spec.ts`, `test/integration/email-receipts-profile.integration.spec.ts` |
| Categories by the AI: the three rows of section 7, invalid choices dropped, no call without the flag, no call from the poll's automatic step | `ai/email-receipt-ai.categories.spec.ts`, `pipeline/email-receipt-pipeline.profile.spec.ts`, `poll/email-receipt-poll.service.spec.ts` |
| Bulk processing: termination by `since`, a failed email not retried, the statuses taken, `remaining` | `receipts/email-receipts.service.spec.ts`, `test/integration/email-receipts-profile.integration.spec.ts` |
| Approve in bulk: one transaction per request, a refusal leaves the others, the limit counts each, the ownership of every id | `ai-review/ai-review-approval.service.spec.ts`, `test/integration/email-receipts-profile.integration.spec.ts` |
| The write-limit exemption: decided on the server from the stored claimant and switch, never from the request | `ai/actions/ai-actions.service.spec.ts`, `ai-review/ai-review-requests.service.spec.ts`, `test/integration/email-receipts-profile.integration.spec.ts` |
| AI extraction: amount conversion, unknown category (item, shipping, discount), dropped items, completeness through the shared function, `source: "ai"`, description-only reasons | `ai/email-receipt-ai.extraction.spec.ts`, `ai/email-receipt-ai.service.spec.ts` |
| Recognize with AI: refusals before any write, chosen transaction stored as manual, pending request visible in the inbox, claim by id, card confirm applies the request | `email-receipt-ai.service.spec.ts`, `test/integration/email-receipts-pipeline.integration.spec.ts` |
