# Return of Capital

Specification for the `RETURN_OF_CAPITAL` investment action (issue #1800):
Microsoft Money's "Return of Capital" activity, which Monize did not offer. A
fund or trust pays out cash that is not income but part of what the investor
paid for the shares. Written per `docs/financial-calculation-contract.md`
section 9.

## 1. The model

No new column. `RETURN_OF_CAPITAL` is a value of the `investment_action` enum
(migration `20261022142530_return_of_capital_action.sql`) and a **base action of
its own**, not a refinement in `baseInvestmentAction`: its cash behaves like a
DIVIDEND's, but its effect on the basis and on income does not, and a
refinement moves everything exactly as its base does.

| Field | Value |
| --- | --- |
| `security_id` | required: the distribution reduces one security's basis |
| `quantity`, `price` | unused; the form sends the amount as `price` with no quantity, as for a dividend |
| `total_amount` | the cash paid, in the security's currency, unsigned |
| `exchange_rate` | security currency to the settlement account's, as for a dividend |
| `funding_account_id` | optional cash destination, exactly as a dividend's |

## 2. Invariants

1. **Cash arrives like a dividend.** One linked cash row for
   `total_amount x exchange_rate`, into the funding account when one is named,
   otherwise the brokerage's linked cash account (`computeInvestmentCashImpact`,
   `createCashTransactionInTransaction`). It may be embedded in a split
   (`EMBEDDED_INVESTMENT_SPLIT_ACTIONS`).
2. **No shares move.** `applyActionToQuantity` returns the quantity unchanged;
   the action is not in `SHARE_MOVING_ACTIONS`.
3. **It comes off the basis, never below zero.** Every replay that carries a
   basis folds the row through `applyReturnOfCapital`
   (`backend/src/securities/investment-replay.util.ts`): the position's total
   cost falls by the amount, and stops at zero.
4. **Only the excess is a gain.** What the basis could not absorb is a capital
   gain realized on the distribution's date, with no shares sold. This is the
   IRS's treatment of a nondividend distribution (Publication 550) and the
   CRA's of a negative adjusted cost base.
5. **It is not income.** It is not in `CASH_INCOME_ACTIONS`, `incomeKind` is
   `null`, and it is in no dividend, interest or capital-gain-distribution
   total.
6. **It is capital leaving the invested part.** `investedFlowKind` is
   `capitalOut`, so a period result does not read the price drop it causes as
   a loss, and net invested treats its cash like a sale's proceeds.
7. **A total return includes it.** The custom investment report's period
   returns add it to the cash distributions over the window, because the price
   falls by what was paid back.

## 3. Numerical examples

| Position before | Return of capital | Basis after | Realized gain |
| --- | --- | --- | --- |
| 100 shares, basis 1,000 | 150 | 850 (8.50/share) | 0 |
| 10 shares, basis 500 | 700 | 0 | 200 |
| 10 shares, basis 0 | 40 | 0 | 40 |

A later sale of the first position for 1,200 realizes 350 (1,200 - 850), not
200.

In a month where 100 shares at 50 pay back 200 and the price falls to 48, the
capital-gains-by-period replay reports `sells` 200, total capital gain 0,
realized 0 and unrealized 0.

## 4. Missing data

- A row whose stored rate is zero or negative cannot be converted:
  `returnOfCapitalAmount` returns `null`, and an account-currency replay marks
  the basis unknown (`mixed_basis_currency` in the cost-basis lots,
  `basisKnown = false` in the capital-gains replay) rather than leaving it
  unreduced.
  The capital-gains-by-period replay reads the raw stored rate, never the
  `|| 1` fallback its trades use, so the period's figures are `null` rather
  than converted at par. The realized-gain replay, which has no completeness
  flag, leaves the basis unreduced, exactly as it leaves an unpriced
  acquisition out of the basis.
- A return of capital that settled in a different currency from the basis it
  would reduce leaves that basis unknown, the same test an acquisition passes.

## 4.1 Rows imported before this change

QIF `RtrnCap` rows imported before this change were stored as `DIVIDEND`, and
stay that way: nothing rewrites a stored action, because a dividend is a
legitimate row and only the person who imported it knows which rows were
really returns of capital. Until they are edited, those rows count as dividend
income and leave the basis unreduced. Changing a row's action to Return of
Capital in the transaction form corrects both; the holdings rebuild that every
write runs recomputes the basis.

## 5. Where each surface reads it

| Surface | Mechanism |
| --- | --- |
| Stored holdings (`computeHoldingsMap`), undo rebuild, SPLIT preview (`getHoldingAt`) | `applyReturnOfCapital` in the security's currency |
| Cost-basis lots, realized gains, capital gains by period | `applyReturnOfCapital` in the holding account's currency; a realized-gain row for the excess carries `action: RETURN_OF_CAPITAL`, `quantity` and `price` 0, and the report labels it |
| Custom investment report | basis and realized gains through `applyReturnOfCapital`; period returns count the cash |
| Net invested (`computeInvestmentFlows`) | with the sale proceeds |
| Invested-capital flows | `capitalOut` |
| QIF import | `RtrnCap` maps to it (it imported as DIVIDEND before) |
| Money (`.mny`) import | not mapped: the `act` code is not known from any measured file |
| Scheduled transactions | an amount-only, security-required action |
| AI assistant and MCP | in the action enums; the tool descriptions say it is not a dividend |

## 6. Tests

`investment-replay.util.spec.ts` (the helper and the classification tables),
`holdings.service.spec.ts`, `portfolio-calculation.service.spec.ts`,
`investment-report-data.service.spec.ts`, `investment-transactions.service.spec.ts`,
`import-investment-processor.service.spec.ts`, and the frontend form and
helper tests.
