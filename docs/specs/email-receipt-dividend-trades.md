# Spec: dividends and reinvested dividends in trade profiles

Status: **proposed**. Extends the trade-confirmation design,
[`email-receipt-trades.md`](./email-receipt-trades.md),
which left dividends and reinvestments out of scope.

Related: INV-RECEIPT-008 (a trade email creates an investment transaction only
through the review card and the confirm), INV-TRADE-001 (the executed total is
the fact, the price is derived from it).

---

## 1. What changes

A trade profile reads four kinds of brokerage email instead of two:

| Action read | Ledger action | Shares move | Cash moves |
|---|---|---|---|
| `BUY` | `BUY` | in | out |
| `SELL` | `SELL` | out | in |
| `DIVIDEND` (a cash dividend) | `DIVIDEND` | no | in |
| `REINVEST` (a dividend reinvested in shares, a DRIP) | `REINVEST` | in | no |

`REINVEST` is booked as one row. The ledger already counts a `REINVEST` row as
dividend income and as an acquisition (`securities/investment-replay.util.ts`),
so no separate `DIVIDEND` row is written for it.

The profile's `trade.quantity` is no longer required. `action`, `symbol`, and
`total` or `price` are still required, and so is an account rule or a default
account.

## 2. Reading the action

`parseTradeAction` (`backend/src/email-receipts/parsing/parse-trade.ts`) splits
the `{action}` capture into words and looks for them in this order:

1. A reinvestment word (`reinvest`, `reinvested`, `reinvestment`, `drip`,
   French `réinvesti`, `réinvestissement`, and the unaccented forms) gives
   `REINVEST`, even when the text also says "dividend" or "buy" ("Dividend
   reinvested", "DRIP buy").
2. Exactly one of a buy word and a sell word gives `BUY` or `SELL`, as before,
   even beside a dividend word. A fund's name can hold one ("Bought 10 Vanguard
   High Dividend Yield ETF"), and an approved buy profile must not start
   booking such buys as dividend income. Both a buy and a sell word give no
   reading.
3. Otherwise a dividend word (`dividend`, `dividends`, `distribution`,
   `distributions`, `dividende`, `dividendes`) gives `DIVIDEND`. None of them is
   no reading (`trade_no_action`).

A word has to match exactly, so "Dividendary" is not a dividend.

## 3. Completeness

The first missing thing is still the reason:

| Action | Needs a share count | Needs an amount |
|---|---|---|
| `BUY`, `SELL`, `REINVEST` | yes (`trade_no_quantity`) | total or price |
| `DIVIDEND` | no | total, or a price together with the share count |

A dividend that states only the amount per share and no share count has no total
to propose, so it is `trade_no_amount`.

## 4. Arithmetic

Amounts are in integer 1/10000 units and share counts in 1e-8 units, as for buys
and sells.

The commission is added for `BUY` and `REINVEST` and taken off for `SELL` and
`DIVIDEND`:

- Total implied by a price: `round(q * p)` plus the commission for `BUY` and
  `REINVEST`, minus the commission for `SELL` and `DIVIDEND`.
- Consistency check: the gross is `T - c` for `BUY` and `REINVEST`, and `T + c`
  for `SELL` and `DIVIDEND`. The tolerance is the same as for buys and sells.

`consistent` is computed only when the email states the shares, the price and
the total. Otherwise it is `null`.

Worked examples, from the fixture
`backend/src/email-receipts/parsing/fixtures/wealthsimple-dividend.ts`:

- **Cash dividend, amount only.** "Amount: $12.34" reads as total `123400`,
  quantity `null` and `consistent` `null`. It is proposed as a DIVIDEND of
  12.34.
- **Cash dividend stated per share.** "Shares: 100", "Price: $0.1234" and no
  total gives `round(100 * 0.1234) = 12.34`.
- **Figures that disagree.** The same with "Amount: $123.40" is
  `consistent: false`.
- **Reinvested dividend.** "Shares: 0.3721", "Price: $33.16", "Amount: $12.34":
  `0.3721 * 33.16 = 12.3388`. The difference of 0.0012 is within
  `0.3721 * 0.005 + 0.01 = 0.0119`, so it is `consistent: true`.

## 5. The ledger duplicate check

`findTradeInLedger` (`backend/src/ai-review/trade-ledger.ts`) compares a
different field depending on the action:

- **BUY, SELL and REINVEST** compare the share count, as before.
- **DIVIDEND** compares `total_amount` instead of the quantity. A cash dividend
  moves no shares, and `create()` stores a quantity of `0` when none is given.
  Comparing a share count would therefore miss a manual entry of the same
  dividend, or match a different one.

The same function runs before the proposal, when the card is built, and inside
the confirm under the holdings lock. Before this change the confirm-time check
was skipped when the quantity was null. It now runs for a dividend, comparing
the amount.

`tradeMatchesOnQuantity` in `backend/src/ai-review/trade-action.ts` decides
which comparison an action uses.

A broker on a DRIP may send one email for the payout and one for the shares it
bought. So when a `DIVIDEND` or `REINVEST` email finds no match of its own
action, a same-day row of the other action for that account and security sets
`anyMatch`. The email is still proposed, but it never auto-applies.

## 5.1 A reinvestment's figures

A `REINVEST` row carries no cash total: `deriveInvestmentTotal` gives 0 and a
supplied total is ignored. `create()` also refuses it without a price above
zero. So the card is previewed with the price the email's total implies,
`(total - commission) / shares` at ten decimals (`tradeCardAmounts`), and with
no total. The receipt detail and the booked-row summary show what it cost, its
shares at its price plus the commission (`TRADE_ROW_AMOUNT_SQL` in
`trade-ledger.ts`).

A cash dividend with no share count is previewed with price = total, because
`derivePriceFromTotal` divides by `quantity || 1`. `readTradeProposal` therefore
reports its price as `null`, so no amount per share is shown. When such a card
posts a matched dividend schedule, it leaves the schedule's own shares and price
in place, and its total is the fact.

## 6. The auto-apply gate

`tradeMayAutoApply` (`parse-trade.ts`) replaces the bare
`consistent === true` test. The mailbox switch, the approved profile and the
empty ledger are still required as well.

| Action | `consistent` | May auto-apply |
|---|---|---|
| any | `true` | yes |
| any | `false` | no |
| `DIVIDEND` | `null` | yes (decided by the maintainer: a complete cash dividend has nothing to cross-check) |
| `BUY`, `SELL`, `REINVEST` | `null` | no |

The trade-off is that a misread dividend amount or ticker can be booked
unattended. Two things limit the damage: the ticker must resolve to exactly one
of the user's securities in the trade's currency, and the ledger must not
already hold a dividend for that security, day and amount.

## 7. Missing data

- An email that states no account and no default account is still
  `trade_no_account`.
- A ticker the user does not hold is still refused when the card is built
  (`tradeSecurityUnknown`).
- A dividend's quantity and price may be `null` in the proposal, the card and
  the receipt detail. The interface shows the amount without inventing a share
  count. The ledger row stores the quantity as `0` and derives the price from
  the total (`derivePriceFromTotal`), as a manually entered dividend does.

## 8. Agents

`aiReviewAgentTradeSchema` (`backend/src/ai-review/ai-review-work.types.ts`)
accepts `DIVIDEND` and `REINVEST`. `quantity` may be absent or null only for a
`DIVIDEND`.

`RECEIPT_TRADE_CHAT_INSTRUCTION` now mentions dividends. Requests already queued
with the earlier text still need to map to the same `tradeChat` key, and still
need to read as the AI's request rather than the profile's. For that, the
earlier text is kept in `RECEIPT_TRADE_CHAT_INSTRUCTIONS`.

## 9. Test matrix

| Layer | What |
|---|---|
| Reader (`parse-trade.spec.ts`) | Action words and their order; a cash dividend amount only; per share with shares; per share without shares; figures that disagree; a reinvestment and one without shares; a buy that a profile reads without a quantity field; commission direction for DIVIDEND and REINVEST; `tradeMayAutoApply` table |
| Validator (`parse-trade.spec.ts`) | A profile without `quantity` is valid; `action` and `symbol` are still required |
| Ledger (`trade-ledger.spec.ts`) | DIVIDEND compares the amount, also when the email states shares; REINVEST compares the shares |
| Pipeline (`email-receipt-trade.service.spec.ts`) | The dividend input has no shares; duplicate check by amount; gate passes a cash dividend, holds an inconsistent one, passes a cross-checked reinvestment |
| Card (`ai-review-work.service.spec.ts`) | An agent's dividend without shares previews as DIVIDEND; a buy or reinvestment without shares is refused |
| Confirm (`ai-actions.service.spec.ts`) | Confirm-time duplicate check of a dividend, by amount |
| Proposal and link (`email-receipt-trade-proposal.spec.ts`, `email-receipt-trade-link.service.spec.ts`) | DIVIDEND without quantity and price, REINVEST; candidates for both; none for another action |
| Instructions (`receipt-instructions.spec.ts`, `email-receipts.service.spec.ts`) | Both chat texts map to `tradeChat` and read as `ai` |
