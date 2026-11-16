# Spec: GEM recommendation-change notifications

Status: **proposed, awaiting maintainer approval.** Requested by the branch author
("informacje o zmianie rekomendacji w gem" -- notify on a change of GEM
recommendation), with the RISK_ON/RISK_OFF state change wanted as its own distinct
event. The maintainer signs off before this ships to `main`.

Owner: notification-center + strategies. Related: #1291,
`notification-preferences.md`, `docs/gem-strategy.md`, INV-NOTIFY-001 (the write
door), `gem-signal.service.ts` (the authoritative signal materializer).

---

## 1. What this adds

Once a day, the Notification Center checks each of the user's GEM strategies and,
when the strategy's **current-period recommendation differs from the previous
period's**, raises one notification (`strategies` category). Two kinds of change,
per the requester:

- **Risk-state change** (`kind: "risk"`): the strategy moved `RISK_ON <-> RISK_OFF`.
  This is the headline event -- the strategy went from holding an equity role to the
  safe asset, or back -- and it fires as its own notification even though it always
  implies an allocation change too.
- **Allocation change** (`kind: "allocation"`): the risk state is unchanged but the
  target role or target security moved (e.g. one equity leg overtook another). Fires
  only when a risk-state change did not.

Exactly one notification per (strategy, period, kind): a risk-state change fires the
`risk` notification; a same-state allocation change fires the `allocation` one; a
period with no change is silent.

## 1.1 The one rule: a change between periods, never an observation of the current one

Like every producer, this fires on a **crossing** -- here, the transition between
the previous evaluated period and the current one -- never on merely observing that
the current recommendation is, say, RISK_OFF. Re-running the daily cron over the
same current period raises nothing the second time. The mechanism is the dedupe key
carrying the current period's `evaluated_on` (Section 4): the first run writes the
row, every later run over the same period is an `ON CONFLICT DO NOTHING` no-op.

---

## 2. Where the recommendation lives (as-is)

`gem_strategy_signals` holds one row per `(strategy_id, evaluated_on,
algorithm_version)`: `state` (`RISK_ON` | `RISK_OFF`), `target_role`,
`target_security_id`, `previous_role`, `effective_from`. Signals are materialized
**lazily** on report read by `GemSignalService.materialize(userId, strategy, assets,
asOf)` (orchestrated by `GemStrategyService`), which returns the materialized
`signals` for the strategy's calendar. There is no cron that recomputes GEM today,
so this producer needs its own daily tick to materialize the current period and
compare it with the previous one -- it reuses the existing materializer (the shared
implementation), never a second evaluation of the signal.

---

## 3. Invariants

- **INV-GEM-NOTIFY-001 (change between periods, not level).** A notification is
  raised only when the current period's `(state, target_role, target_security_id)`
  differs from the immediately preceding period's, read from the two latest
  `gem_strategy_signals` rows of the current `algorithm_version`. A single period
  with no predecessor (a brand-new strategy's first signal) is **not** a change and
  raises nothing.
- **INV-GEM-NOTIFY-002 (one notification per (strategy, period, kind)).** A
  risk-state change fires `kind: "risk"`; an allocation-only change fires `kind:
  "allocation"`; the two are mutually exclusive for one period (a state change is a
  `risk`, never also an `allocation`). The dedupe key
  `gem:<strategyId>:<evaluated_on>:<kind>` makes the daily cron idempotent per
  period.
- **INV-GEM-NOTIFY-003 (a non-evaluable period is unknown, not "no change").** If the
  current period cannot be materialized (prices for the boundary date are not in
  yet), there is no current signal, so there is nothing to compare and the producer
  is a **no-op** -- it never reads "no change" from a missing evaluation. The signal
  is authoritative only once materialized.
  The current period is the report's current signal: `detectSignalChange`
  compares the two newest history rows only when the newest one is
  `report.signal.evaluatedOn`, so a period not yet evaluable never re-announces an
  older change (A26-L24). The `gem:` dedupe row is state-keyed
  (`STATE_KEYED_DEDUPE_PREFIXES`): the retention purge keeps it until it was
  dismissed a year ago, so a period that outlasts the 30-day window is not
  announced twice.
- **INV-GEM-NOTIFY-004 (one writer, reuse the materializer).** Written through
  `NotificationDispatchService.notify` -> `NotificationService.create`
  (INV-NOTIFY-001), from a cron under `withSystemContext` fan-out / `withUserContext`
  body, after the daily price refresh. The signal comparison reuses
  `GemStrategyService`'s materialize path; it never re-implements the GEM evaluation
  (`gem-momentum.util.ts` / `gem-signal.service.ts` stay the only evaluators).
- **INV-GEM-NOTIFY-005 (execution state is not recommendation change).** The
  `executed` / `executed_at` columns record whether the user acted; they are not
  read here. The notification is about what the strategy now recommends, whether or
  not the user has rebalanced.

---

## 4. The producer

Cron service `GemSignalChangeAlertService`, daily after the price refresh:

```
for each user with at least one GEM strategy:           // withSystemContext fan-out
  withUserContext(userId):
    for each strategy of the user:
      const { signals } = gemStrategyService.materializeReport(userId, strategy)  // reuse
      const [current, previous] = twoLatestByEvaluatedOn(signals)  // current algo version
      if (current == null || previous == null) continue           // INV-GEM-NOTIFY-003/001
      const stateChanged  = current.state !== previous.state
      const targetChanged = current.targetRole !== previous.targetRole
                         || current.targetSecurityId !== previous.targetSecurityId
      if (!stateChanged && !targetChanged) continue               // no crossing
      const kind = stateChanged ? "risk" : "allocation"           // INV-GEM-NOTIFY-002
      await dispatch.notify(userId, {
        type: GEM_SIGNAL_CHANGED,
        severity: kind === "risk" ? NotificationSeverity.WARNING   // risk move is the loud one
                                  : NotificationSeverity.INFO,
        title, message,                                            // English fallback; client localizes
        data: { strategyId, strategyName, kind,
                fromState: previous.state, toState: current.state,
                fromRole: previous.targetRole, toRole: current.targetRole,
                targetSecurityId: current.targetSecurityId, evaluatedOn: current.evaluatedOn },
        target: `/reports/gem-strategy`,                           // route asserted by the contract test
        dedupeKey: `gem:${strategyId}:${current.evaluatedOn}:${kind}`,
      })
```

`data` is a snapshot of a **closed** evaluation (a past `evaluated_on`), so it is
safe to store -- it is not a future occurrence that must be re-resolved. The dedupe
key carries the period and the kind, so at most one `risk` and one `allocation` row
exist per period, and re-running the cron is a no-op. Delivery, throttle and fan-out
are the seam's.

`data.targetSecurityId` is an id the row already holds elsewhere, never a security
name or a price -- the wire stays privacy-minimal, and the bell resolves the
security name from the id on read.

---

## 5. New notification type, category and copy

- `NotificationType`: `GEM_SIGNAL_CHANGED` (<= 30 chars). One type; `data.kind`
  distinguishes `risk` from `allocation`, and the client composes the two messages.
- `NotificationCategory`: `STRATEGIES = "STRATEGIES"`. GEM is its own category (not
  folded into `INVESTMENTS`) so a user can opt into strategy signals without the
  daily portfolio-movement stream, and vice versa -- the two are unrelated in intent.
- `notificationCategoryOf` maps `GEM_SIGNAL_CHANGED -> STRATEGIES`;
  `typesForCategory(STRATEGIES)` includes it.
- `NOTIFICATION_CATEGORY_CHANNELS` gains `STRATEGIES`
  (`{ email: true, emailNotification: true, push: true, unifiedpush: true }`);
  `NOTIFICATION_PREFERENCE_CATEGORIES` gains it (user-configurable, opt-in);
  `PUSH_CATEGORY_COPY` gains its generic copy plus `push.notification.strategies`
  (English-first, pseudo regenerated).
- Frontend mirrors + client copy composition (`risk` and `allocation` messages,
  localized) + `notification-target` mapping to `/reports/gem-strategy`, held by the
  same three contract tests.

---

## 6. Missing-data / edge policy

- **Current period not evaluable** (prices missing) -> no current signal -> no-op
  (INV-GEM-NOTIFY-003). Never "no change".
- **First-ever signal** (no previous period) -> not a change -> silent
  (INV-GEM-NOTIFY-001).
- **Config or algorithm-version change**: `materialize` recomputes stale periods in
  place; the producer compares the two latest of the **current** `algorithm_version`,
  so a legacy-version row never poses as the previous period.
- **Deleted strategy** mid-run: `materialize` reports `strategyMissing`; the producer
  skips it (nothing to compare).

---

## 7. Deliberate trades

- **Reuse the materializer, add a daily tick.** GEM has no recompute cron; rather
  than add signal evaluation to a hot path, a daily job materializes the current
  period (idempotent -- `materialize` writes only missing periods) and compares. This
  keeps `gem-signal.service.ts` the single evaluator (INV-GEM-NOTIFY-004).
- **Its own category, not `INVESTMENTS`.** Strategy signals and daily portfolio
  movement are different intents; separate categories let a user take one without the
  other, at the cost of one more `NotificationCategory` member. (Per-type toggles
  within a category are the deferred finer-grained feature, `notification-preferences.md`
  Section 16.4.)
- **State change is the loud event.** A `RISK_ON <-> RISK_OFF` move is `WARNING` and
  fires as its own `risk` notification even though it implies an allocation change,
  because it is the one the requester most wants to see; an intra-state allocation
  shuffle is `INFO`.

---

## 8. Decisions (confirmed with the requester; maintainer signs off)

- **D1. Fire on a recommendation change**: risk-state (`RISK_ON <-> RISK_OFF`) and
  target (role/security) change.
- **D2. RISK_ON/RISK_OFF is a separate, louder event** (`kind: "risk"`, `WARNING`),
  distinct from an intra-state allocation change (`kind: "allocation"`, `INFO`).
  Confirmed by the requester ("tez zmiana stanu RISK_ON/OFF osobno").
- **D3. Category = `STRATEGIES`, opt-in, default off** (GEM is an advanced feature;
  no strategy, no rows).
- **D4. Cadence = daily**, after the price refresh; compares the two latest periods
  of the current algorithm version.
- **D5. Deep link = `/reports/gem-strategy`** (the report route;
  `frontend/src/app/reports/gem-strategy/page.tsx`).

---

## 9. Test matrix (offline-runnable except where noted)

1. **Risk-state change fires `risk`** (INV-GEM-NOTIFY-001/002): previous `RISK_ON`,
   current `RISK_OFF` -> one `kind:"risk"` row, `WARNING`.
2. **Allocation-only change fires `allocation`**: same state, different target role ->
   one `kind:"allocation"` row, `INFO`; state-change case does not also fire an
   allocation row.
3. **No change is silent**: identical state, role and security between periods -> no
   row.
4. **First signal, no predecessor** -> silent (INV-GEM-NOTIFY-001).
5. **Non-evaluable current period** -> no current signal -> no-op, never "no change"
   (INV-GEM-NOTIFY-003).
6. **Idempotent daily run**: two cron runs over the same current period write one row
   per kind (dedupe key carries `evaluated_on` and `kind`).
7. **Legacy algorithm version ignored**: a stale-version row is not read as the
   previous period.
8. **Reuse, not re-implementation** (INV-GEM-NOTIFY-004): a source scan asserts the
   producer calls `GemStrategyService`/`GemSignalService`, never `gem-momentum.util`
   directly.
9. **Write door / category wiring / target route / delivery matrix**: the
   `STRATEGIES` category resolves, the target resolves, one writer, the three
   frontend contract tests pass.

Integration (CI-owned): materialize + compare against a real `gem_strategy_signals`
table across a genuine period boundary; the RLS scoping; the delivery matrix for the
new category.
