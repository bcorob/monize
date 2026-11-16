# Spec: AI review proposal notifications

Status: **approved by the maintainer on 2026-10-18.** The product decisions were
made by the feature's requester on 2026-10-18: notify when new proposals wait
for approval, and remind before they expire; the channels are set in the
notification matrix like every other category.

Owner: ai-review. Related: `docs/backend/mcp.md` (`ai_review_requests`),
`notification-preferences.md` (the delivery matrix), `system-alerts.md` (the
dedupe-key pattern), INV-NOTIFY-001 (the write door,
`NotificationDispatchService.notify`).

---

## 1. What this adds

An agent (the in-app assistant or an MCP client) answers an AI review request
with a proposal: the request becomes `proposed` and waits for the person to
approve or dismiss it in the review inbox (`/ai-reviews`) or in the chat. A
request expires at `expires_at` (30 days after it was raised,
`AI_REVIEW_REQUEST_LIFETIME_DAYS`), and an expired proposal is lost. Today
nothing tells the person that a proposal waits, so most of them expire unseen.

Two producers write Notification Center rows:

1. **Proposals ready.** Open proposals arrived since the last notice.
2. **Proposals expiring.** One or more open proposals expire within 3 days.

Only `proposed` requests count. A `pending` or `claimed` request waits for an
agent, not for the person, and needs no notice.

## 2. Types and category

| Type | Category | Severity | When |
|---|---|---|---|
| `AI_REVIEW_PROPOSALS_READY` | `AI_REVIEW` | `info` | open proposals arrived since the last ready notice |
| `AI_REVIEW_PROPOSALS_EXPIRING` | `AI_REVIEW` | `warning` | proposals reached the 3-day mark before expiry |

A new category, so the person can switch it off without touching another
one. `category` is `VARCHAR(20)` and `alert_type` is `VARCHAR(30)`, neither
with a CHECK, so no migration is needed (`notification-category.spec.ts`
holds the length bound).

**Default channels:** the global defaults, as `EMAIL_RECEIPTS` has them
(`NOTIFICATION_CATEGORY_DEFAULTS`). A stored matrix row always wins.

## 3. Proposals ready

`AiReviewNotificationService.notifyReady`, run by the hourly AI review sweep
(`AiReviewRequestsExpiryService.sweepQueue`, `20 * * * *`) after the expiry
step, so an expired request is never counted.

- The fan-out (`withSystemContext`) lists the users with at least one
  `proposed` request whose `expires_at > CURRENT_TIMESTAMP`.
- Per user, under `withUserContext`, one query reads `count` (all live
  `proposed` requests) and `added`: the live `proposed` requests whose
  `updated_at` is later than `created_at` of the user's newest
  `AI_REVIEW_PROPOSALS_READY` notification, **dismissed or not** (none means
  every live proposal counts). Both timestamps are the database clock. Notify
  when `added > 0`. Approving, dismissing or expiring proposals raises nothing
  by itself, and an old notice that was never dismissed does not hide later
  proposals: the baseline is a time, not a count.
- **Why `updated_at` marks arrival:** the `update_ai_review_requests_updated_at`
  trigger sets it on every UPDATE, and every UPDATE of a `proposed` row moves
  it out of `proposed` (`applied`, `rejected`, `expired`). The one exception is
  a foreign key action (`email_receipt_id` or `rule_id` set to NULL when the
  email or the rule is deleted), which fires the trigger and so counts that
  proposal as new once, at the next run. Accepted.
- **Idempotency:** `dedupeKey = air:ready:<UTC date>T<UTC hour>` (for example
  `air:ready:2026-10-18T10`), taken from the run's clock. Replicas firing the
  same hourly sweep collapse on it: a replica that loses the insert gets `null`
  from `create` and sends nothing. A later hour has a new key, so new
  proposals notify again the same day.
- `data = { count, added }`.

Example: 09:20 no proposals. An agent proposes 3 at 10:05: the 10:20 run
notifies "3 proposals wait" (`count = 3`, `added = 3`). The person approves all
3 at 11:00 and leaves the notice: the 11:20 run raises nothing (no live
proposal). An agent proposes 2 a week later: that run notifies (`count = 2`,
`added = 2`), although 2 is less than 3. One more arrives at 13:10 while those
2 are still open: the 13:20 run notifies (`count = 3`, `added = 1`).

## 4. Proposals expiring

`AiReviewNotificationService.notifyExpiring`, a daily cron at `41 7 * * *`
(UTC).

- The fan-out (`withSystemContext`) lists `proposed` requests with
  `expires_at` in `[now + 2 days, now + 3 days)`, grouped by user. A request
  enters this window on exactly one daily run, so each proposal is reminded
  once without a stored marker.
- Per user, under `withUserContext`, one notification for the whole group.
- **Idempotency:** `dedupeKey = air:exp:<UTC date>`.
- `data = { count, earliestExpiresAt }` (ISO timestamp). The client renders
  the date in the reader's language and timezone.
- **Accepted limit:** a run that does not happen (an outage of a whole day)
  skips the requests that crossed the mark that day. They still show in the
  inbox and in the "ready" notice; no catch-up burst is sent.

## 5. Copy and privacy

Title and message carry counts and the date only. Never the instruction (the
person's own words), a payee, an amount or the email text (a third party's
words): push and email leave the server. Every row has
`target = /ai-reviews`.

Copy keys (English first, then every locale):

- backend: `emails.json` (title, message per type), `push.json` (category
  copy, `PUSH_CATEGORY_COPY`);
- frontend: `notifications.json` (both types, `useNotificationCopy`),
  `settings.json` (the matrix row label and help).

## 6. Files

- `backend/src/notification-center/entities/notification.entity.ts`: two
  types, `NotificationCategory.AI_REVIEW`, the partition array,
  `notificationCategoryOf`.
- `backend/src/notification-center/notification-preference.service.ts`:
  category list, channels, defaults.
- `backend/src/notifications/notification-dispatch.service.ts`,
  `notification-email-copy.ts`, `notification-email-messages.ts`: push and
  email copy.
- `backend/src/ai-review/ai-review-notification.service.ts` (new) and the
  wiring in `ai-review-queue.module.ts` and the sweep; the new
  `withUserContext` call site in `WITH_CONTEXT_ALLOWLIST`
  (`backend/eslint.config.mjs`).
- `frontend/src/types/notification.ts`,
  `frontend/src/lib/notification-preferences.ts`,
  `frontend/src/hooks/useNotificationCopy.ts`,
  `frontend/src/components/notifications/NotificationList.tsx`.
- `docs/cron-jobs.md` (the new cron and the sweep's extra step),
  `docs/specs/notification-preferences.md` (the new category).

## 7. Test matrix

| Case | Kind |
|---|---|
| No previous notice: `added` is the whole count | unit |
| Old notice never dismissed, all its proposals since approved, new ones arrive: notify | unit |
| No proposal newer than the last notice: nothing | unit |
| Baseline is the newest ready notice, dismissed or not | unit (query text) |
| Hourly dedupe key; a later hour notifies again | unit |
| Expired and `pending`/`claimed` requests are not counted | unit + integration (query) |
| Expiring window: a request 2 days 23 hours ahead counts, 3 days ahead and 1 day 23 hours ahead do not | unit (window bounds) |
| One expiring notice per user per day across two concurrent runs | integration (dedupe index) |
| One user's failure does not stop the others | unit |
| Copy has no instruction, payee, amount or email text | unit (copy builder) |
| Category maps both types; length bound | `notification-category.spec.ts` |
| Matrix shows the new row; client copy renders both types; link opens `/ai-reviews` | frontend unit |
