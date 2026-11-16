# System alerts: tell the operator inside the app they actually open

Status: implemented.

## The failure this replaces

A failed automatic backup wrote `last_backup_status = 'failed'` onto
`auto_backup_settings` and logged one line. Nothing notified anybody; the
status was visible only on a Settings section most operators never revisit,
and promotion-copy and retention-delete failures did not even leave that --
they logged a `warn` and the status stayed `success`. A missing
`ENCRYPTION_KEY` was a startup log warning (issue #1269's silent state, one
release on; it now refuses the boot instead). A provider outage emailed the administrators but showed nothing
in the app, and a deployment without SMTP got nothing at all -- including,
by construction, any report that SMTP itself was broken.

## What now happens

System-level issues are raised as rows in the existing alerts interface --
the `notifications` table behind the bell dropdown -- by
`backend/src/system-alerts/system-alert.service.ts`, and the admin-facing
ones also email the administrators. `SystemAlertMonitorService` beside it
owns the two conditions nothing else watches -- the encryption key and SMTP
health -- on one 15-minute sweep.

### Audience

An issue only an administrator can act on goes **only to administrators**:
one row per active admin (RLS keys `notifications` on `user_id`, so a
deployment-wide fact is materialized per recipient, each independently
readable and dismissible). The recipient predicate is written once, in
`queryAdminRecipients` (`backend/src/users/admin-recipients.util.ts`):
`role = 'admin'`, active, not delegate-only. The email leg further requires
an address and `notification_email` not switched off; the in-app row does
not. `ProviderOutageAlertService` resolves its email recipients through the
same function, so the two surfaces cannot drift.

An issue the affected user can act on themselves -- their scheduled
transaction failing to post -- goes to that user, in-app only.

### The alert types

| Type | Severity | Audience | Raised from | Dedupe key | Email |
|---|---|---|---|---|---|
| `BACKUP_FAILED` | critical | admins | auto-backup cron catch (**automatic runs only**) | `BACKUP_FAILED:<userId>:<utc-date>` | yes, once per day |
| `BACKUP_PARTIAL` | warning | admins | partial artifact; promotion-copy failure; retention-delete failure (`data.reason` names which), **automatic runs only** | `BACKUP_PARTIAL:<userId>:<reason>:<utc-date>` | yes, once per reason per day |
| `ENCRYPTION_KEY_MISSING` | warning | admins | **retired**: the server now refuses to start without `ENCRYPTION_KEY`, so a running process cannot observe the state. The type stays so rows already raised still render | `ENCRYPTION_KEY_MISSING:<iso-week>` | yes |
| `JWT_SECRET_WEAK` | warning | admins | the 15-minute sweep, and also when an admin's client reads `GET /admin/deployment-status` for the banner (same weekly dedupe key, not awaited), while `jwtSecretWeakness` flags `JWT_SECRET` (a published placeholder or a typed pattern that is long enough to boot); `data.reason` is `placeholder` or `predictable`, never the secret | `JWT_SECRET_WEAK:<iso-week>` | yes |
| `PROVIDER_OUTAGE` | warning | admins | outage claim win | `PROVIDER_OUTAGE:<provider>:<outage start ISO>` | no (bespoke email exists) |
| `PROVIDER_RECOVERED` | success | admins | recovery claim win | `PROVIDER_RECOVERED:<provider>:<outage start ISO>` | no |
| `SMTP_FAILURE` | warning | admins | 15-minute sweep over `EmailService.getFailureSnapshot()` | `SMTP_FAILURE:<utc-date>` | **never** |
| `SCHEDULED_POST_FAILED` | warning | affected user | auto-post cron catch (non-conflict) | `SCHEDULED_POST_FAILED:<scheduledId>:<utc-date>` | no |

`SMTP_FAILURE` never emails whatever the caller passes -- the channel cannot
report its own failure -- and the refusal is enforced inside
`SystemAlertService.shouldEmail`, not left to call sites. It is also raised
only for a **transport** failure: a `550` for one full mailbox means the relay
answered and refused that address, so `EmailService` counts it as a
`recipientRejection` and the sweep never sees it (the same "an answer, however
bad, proves the host answered" rule the provider breaker uses).

**A manual "Back up now" raises nothing.** `applyBackupOutcome` is shared with
the cron, so it takes a `BackupRunOrigin`: an automatic run has nobody
watching, while a manual one returns its outcome to the person who pressed the
button. Alerting on both filed an admin notice titled "Automatic backup
incomplete" about a backup that was not automatic, let a manual partial take
that day's dedupe key and silence the real automatic failure behind it, and
made the HTTP request wait on a per-administrator SMTP fan-out.

**A title is bounded at the door.** Producers interpolate names they do not
control, and `title` is `VARCHAR(255)`: an over-long one makes PostgreSQL raise
22001, which the never-throws contract swallows, so the alert silently never
exists. `NotificationService` truncates once, at the write door, rather than
trusting each producer -- and because every producer goes through that door, the
bound holds for a budget alert and a bill reminder too.

### The two claims and their mechanisms

Every replica runs every cron, so both effects need a cross-replica arbiter
(INV-ALERT-001 in `docs/system-invariants.md`):

- **The row** is claimed by the partial unique index
  `idx_notifications_dedupe` on `(user_id, dedupe_key) WHERE dedupe_key IS
  NOT NULL` (migration 170), written as `INSERT ... ON CONFLICT DO NOTHING
  RETURNING id`. The clause deliberately names no conflict target: it covers
  every unique index on the table at once, which is what lets one write door
  serve both kinds of producer. The fingerprint index from migration 140 cannot
  arbitrate a system alert -- it keys on `budget_id`, which is NULL for every
  one of them, and NULL never equals NULL in a unique index -- and the dedupe
  index cannot arbitrate a budget alert, which leaves `dedupe_key` NULL. A
  producer does not know which index applies to it, and with a bare clause it
  does not have to.
- **The email** goes only to recipients whose row the INSERT actually
  returned -- `NotificationService.create` answers `null` for the loser, which
  is the whole arbitration -- with the same at-most-once trade as
  `ProviderOutageAlertService`
  (`docs/external-side-effects.md`): a process killed between the insert
  committing and SMTP accepting loses that email; the in-app row survives,
  and a duplicated admin alert is the failure mode being designed against.

**A per-user fact does not mean a per-user email.** One broken volume raises
one `BACKUP_FAILED` row per affected user -- an administrator has to know
*which* users lost a backup -- but sixty rows must not send sixty identical
messages. `SystemAlertInput.emailDedupeKey` collapses the mail: the row is
claimed by the unique index as above, and the email additionally requires
winning `JobClaimService.claimOnce(SystemAlertEmail, adminId, key)`. A claim
that itself fails falls through to sending, because a duplicate email is the
lesser outcome once the row exists.

The provider pair additionally sits behind `provider_health`'s existing
conditional-UPDATE claim: the in-app rows are created only after that claim
is won, so the episode semantics (15-minute minimum, 6-hour floor) carry
over unchanged.

### Localization

A system alert is written by a cron with no request locale, so the row
stores **English** `title`/`message` as the fallback and the facts in
`data` (with `system: true`); the bell dropdown composes localized copy
client-side from `data`, exactly as `BILL_DUE` does
(`frontend/src/components/notifications/NotificationList.tsx`). The admin email
renders per-recipient framing through `emailTranslator` around the stored
English title/message (`systemAlertTemplate`).

### Lifecycle and re-alerting

System alert rows live the ordinary alert lifecycle: unread, read, soft
dismiss, and the 30-day purge in `NotificationService.purgeOld`. They are
**not** budget news, so the weekly budget digest filters them out
(`dedupe_key IS NULL`): a system alert raised on the first of a month carries
that day as its `period_start`, which is also the month's budget period start,
and without the filter it was rendered inside the digest for the rest of the
month. The
purge deletes the row **and with it the dedupe key**, so a persistent
condition (a key still missing, SMTP still broken) is re-raised on its next
bucket after the old row ages out. That is intended -- a standing problem
should not be silenced forever by one dismissal -- so do not "fix" the purge
to preserve dedupe keys. Bucket sizes are the per-type spam control: daily
for failures tied to a day's run, weekly for the encryption key.

`SystemAlertService` never throws: an alert is a side reporting channel, and
a failure to raise one must not end the sweep that noticed the original
problem. Both entry points seed their own RLS context (`withSystemContext`
for the admin fan-out, `withUserContext` for the per-user path); callers
invoke them outside any open `withScopedDb` transaction.

## Change to the provider-outage sweep

The sweep no longer stands down when SMTP is unconfigured: the claim also
produces the in-app rows, which are the delivery in that case, and the email
leg skips per-recipient inside `deliver`. "Nobody to tell" now means no
active administrator at all, not merely none with email enabled. See
`docs/specs/provider-outage-alerts.md`.
