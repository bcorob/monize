# Spec: FX conversion completeness

Status: approved for implementation on `claude/detailed-error-review-54i3b3`.
Governs: audit finding P5-009 (missing exchange rates silently treated as 1:1)
and design risk DR-02 (look-ahead to a future rate before history begins).

Read `docs/financial-calculation-contract.md` section 1 first; this spec applies
that rule to currency conversion specifically.

## 1. The defect this replaces

Two conversion paths turned "no rate available" into "rate 1.0":

```typescript
// net-worth.service.ts
const result = convertWithRateLookup(amount, from, to, getRate);
return result ?? amount;                    // <- 1:1

// portfolio-calculation.service.ts
rate = reverseRate !== null ? 1 / reverseRate : 1;   // <- 1:1
```

`convertWithRateLookup` returns `null` precisely so the caller can decide, and
both callers decided to lie. 1,000 USD reported into a EUR total came out as
1,000 EUR rather than 900 EUR: an 11.11% overstatement that is *numerically
plausible*, which is what makes it dangerous. Nothing in the response let a
consumer tell a real 1:1 pair (USD/USD, or a genuinely pegged pair) from an
absent one.

## 2. Invariants

1. **Rate 1 is only ever used when the source and destination currency are the
   same string.** No other branch may produce it as a fallback.
2. A conversion has three outcomes, and they stay distinguishable:
   - `{ value, rate, known: true }` -- a rate was found (or none was needed).
   - `{ value: null, rate: null, known: false }` -- no rate exists for the pair.
   - It is never `{ value: amount, rate: 1 }` for differing currencies.
3. **A total containing an unconverted component is not a total.** Per the
   financial calculation contract section 1, the total field is `null` and the
   partial sum, when still useful, goes in a separately named field with the
   reason attached.
4. A conversion gap is **named**, following the existing `ReplayedLot.basisGap`
   precedent: the response says which pair could not be resolved, not merely
   that something was wrong.
5. Zero is not a valid rate. `convertWithRateLookup` already rejects an inverse
   rate of 0; a direct rate of 0 or a negative rate is equally invalid and is
   treated as absent rather than applied.

## 3. Shape

```typescript
type FxGap = "missing_rate" | "value_unknown";

interface FxTotal {
  /** null unless every component converted. */
  total: number | null;
  /** Sum of the components that did convert. Always present. */
  knownSubtotal: number;
  /** "USD->EUR" for each pair that had no rate. Empty when complete. */
  missingPairs: string[];
  /** Components left out for a reason with no pair to name. */
  unknownCount: number;
}
```

`FxAggregate` (`backend/src/common/fx-aggregate.ts`) accumulates this. Callers
add signed amounts and read the quadruple at the end; they never branch on `null`
themselves, which is what kept the old code's `?? amount` out of sight.

**A component can go missing for two reasons, and only one of them has a
currency to blame.** A missing *rate* is a fact about a pair, and naming it
(`missingPairs`) tells the reader what to fix. A component whose *value* is
unknown -- a scheduled occurrence whose own settlement rate could not be
resolved, an unpriced holding -- is unknown in every currency, so filing it under
a pair would send the reader to refresh a rate that is already there. `addUnknown`
records it by count instead (`unknownCount`), and `isComplete` is false for
either cause: checking `missingPairs` alone reported a total containing an
unpriceable component as complete. `frontend/src/lib/currency-total.ts` splits
the same two causes as `missingCurrencies` and `excludedCount`.

## 4. Numerical examples

| Components | Rates available | total | knownSubtotal | missingPairs |
| --- | --- | ---: | ---: | --- |
| 1,000 USD into EUR | USD->EUR 0.9 | 900 | 900 | [] |
| 1,000 USD into EUR | EUR->USD 1.1111 (inverse only) | 900.0090 | 900.0090 | [] |
| 1,000 USD into EUR | none | `null` | 0 | ["USD->EUR"] |
| 500 EUR + 1,000 USD into EUR | none for USD | `null` | 500 | ["USD->EUR"] |
| 500 EUR + 1,000 USD into EUR | USD->EUR 0.9 | 1,400 | 1,400 | [] |
| 0 USD into EUR | none | 0 | 0 | [] |
| 1,000 EUR into EUR | n/a, same currency | 1,000 | 1,000 | [] |
| 1,000 USD into EUR | USD->EUR 0 | `null` | 0 | ["USD->EUR"] |

Note row 6: **zero needs no rate.** Zero converts to zero at any rate, so a
zero component records no gap -- an emptied foreign account is a settled zero,
not an unknowable value, and both conversion doors (`convertToDefault` and
net worth's `convertCurrency`) short-circuit it before the rate lookup. Note
also row 3 vs row 8: a `knownSubtotal` of 0 can mean "nothing converted"; only
`missingPairs` distinguishes it from a real zero, which is why it is not
optional.

Note the last row: an empty portfolio holds zero and reports `total: 0` with no
missing pairs -- zero is a known answer. `null` is reserved for "not known", per
the root `CLAUDE.md` rule that the two must not be conflated.

## 4a. Staging: what lands now, and what follows

Making `assets` / `liabilities` / `netWorth` / `totalPortfolioValue` nullable is
the correct end state and it changes public response shapes, every chart that
reads them, and the copy that explains a partial total in 22 locales. That is a
separate change with its own frontend work; landing it half-done would leave
charts rendering `null` as a gap in the line with nothing telling the user why,
which is a worse failure than the one being fixed.

**Stage 1 (this branch).** The silent lie is removed and the gap is made
visible:

- `convertToDefault` and `convertCurrency` return `null` for an unresolvable
  pair. Rate 1 is unreachable unless the currency codes are equal.
- Every aggregation accumulates through `FxAggregate`, so an unconvertible
  component is *recorded*, never folded in at 1:1.
- The existing numeric total field carries `knownSubtotal`, and the response
  gains `missingRatePairs` (and `fxComplete`) beside it. A consumer can see
  exactly which pair is missing -- which satisfies the contract's "silence is
  what turns a subtotal into a lie" requirement even before the field goes
  nullable.
- Every such aggregation logs at warn level with the pair and the date.

**Stage 2 (follow-up).** `total*` fields become `number | null`, frontend charts
render an explicit "incomplete" state, and the copy is translated. The
`FxAggregate.total` getter already implements the nullable semantics and is
covered by tests, so stage 2 is a matter of changing the field each call site
reads (`knownSubtotal` -> `total`) plus the consumer work.

Stage 1 is therefore strictly better than the previous behaviour and does not
pretend to be stage 2. `fxComplete: false` with a numeric subtotal is a known,
documented interim state, not an assertion that the total is complete.

## 5. Persisted snapshots (deliberately out of scope here)

`monthly_account_balances` stores converted values. Marking a persisted snapshot
incomplete needs a schema column and a migration, and is therefore a separate
change; this spec covers the calculation and response layers. Until that lands,
a snapshot row whose conversion was incomplete is written from the
`knownSubtotal` **and** logged at warn level with the missing pairs, so the gap
is observable rather than silent. This is recorded as a known limitation, not as
correct behaviour.

## 6. DR-02: look-ahead

`findBestRate` falls back to the *earliest* available rate when none exists on
or before the valuation date, which values a historical point using a rate from
its future. That is look-ahead, and the time-series contract forbids it.

Decision: keep the fallback -- a pre-history chart point is more useful with an
approximate rate than absent -- but stop it being invisible. In this stage the
fallback is logged by `findBestRate` (once per pair per computation), naming
the pair and the valuation date it predates. Reporting it to API consumers as a
named gap (`rate_from_after_valuation_date`), so a chart can label the point,
is deliberately staged with the nullable-totals rollout (section 8) and is
**not implemented yet** -- until then the log is the only signal. Changing the
fallback itself is a product decision and is not made here.

## 7. Test matrix

Every row of section 4, plus:

- same currency, no rates loaded at all;
- direct rate present, inverse absent, and the reverse;
- direct rate of 0 and a negative direct rate (treated as absent);
- a mixed portfolio where exactly one of three currencies is unresolvable --
  asserts `total === null` while `knownSubtotal` covers the other two;
- a liability component (negative amount) that cannot convert;
- the look-ahead case: rate history starts after the valuation date;
- assertion that no code path returns `amount` unchanged for differing
  currencies (source-scanning guard on `?? amount` beside a conversion).
