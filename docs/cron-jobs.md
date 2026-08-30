# Cron Jobs

Cron jobs use the `@Cron()` decorator from `@nestjs/schedule`. They run in the API process (`ScheduleModule.forRoot()` in `backend/src/app.module.ts`); there is no separate scheduler process, and on k8s with more than one backend replica every replica fires every cron.

One row per `@Cron` handler. The Cron column is the decorator's expression verbatim (a
`CronExpression` member resolved to its value -- some carry a leading seconds field), with the
`timeZone` option in parentheses; times without one are server-local.

| Service | Cron | Schedule | Purpose |
|---------|------|----------|---------|
| `demo-reset.service` | `0 4 * * *` | Daily 4 AM | Demo database reset |
| `demo-reset.service` | `0 */3 * * *` | Every 3 hours | Generate intra-day demo transactions |
| `ai-usage.service` | `0 4 * * *` | Daily 4 AM | AI usage cleanup |
| `ai-insights.service` | `0 06 * * *` | Daily 6 AM | Generate AI insights |
| `token.service` | `0 03 * * *` | Daily 3 AM | Expired refresh-token purge |
| `scheduled-transactions.service` | `5 * * * *` | Hourly at :05 | Post due recurring transactions |
| `scheduled-transactions.service` | `25 17 * * 1-5` (America/New_York) | 5:25 PM ET weekdays | Re-derive the account-currency estimate on foreign-currency schedules from the rates the 5:05 PM refresh just stored |
| `exchange-rate.service` | `5 17 * * 1-5` (America/New_York) | 5:05 PM ET weekdays | Fetch exchange rates (staggered after price refresh) |
| `accounts.service` | `0 * * * *` | Hourly | Fold future-dated transactions into account balances as their date arrives in each user's local timezone |
| `net-worth.service` | `0 */30 * * * *` | Every 30 minutes | Recompute current-month net-worth snapshots for accounts whose balance moved since the snapshot was taken (owner-scoped, idempotent across replicas) |
| `mortgage-reminder.service` | `0 08 * * *` | Daily 8 AM | Mortgage payment reminders |
| `bill-reminder.service` | `0 08 * * *` | Daily 8 AM | Bill payment reminders |
| `provider-outage-alert.service` | `*/10 * * * *` | Every 10 minutes | Email the administrators when a market-data provider has been unreachable for 15 minutes, and once more when it recovers; claimed per episode with a 6-hour floor between alerts |
| `budget-period-cron.service` | `0 0 1 * *` | 1st of month, midnight | Create new budget periods |
| `budget-alert.service` | `0 7 * * *` | Daily 7 AM | Budget threshold alerts |
| `budget-alert.service` | `0 7 * * 1` | Mondays 7 AM | Weekly budget digest |
| `budget-alert.service` | `0 3 * * *` | Daily 3 AM | Purge sent alerts older than 30 days |
| `security-price.service` | `0 17 * * 1-5` (America/New_York) | 5 PM ET weekdays | Fetch security prices, then settle the day: re-read each symbol's recent daily bars and overwrite the provisional intraday quotes with the provider's official OHLCV and adjusted close |
| `market-index.service` | `10 17 * * 1-5` (America/New_York) | 5:10 PM ET weekdays | Fetch market index closes for the benchmark overlay (staggered after the price and FX refreshes) |
| `mny-staging.service` | `0 0-23/1 * * *` | Hourly | Delete expired staged import files (24 h TTL) |
| `mny-import-job.service` | `0 0-23/1 * * *` | Hourly | Backstop sweep for import jobs whose worker stopped heartbeating; the reap that a waiting user depends on runs on their own next request, not here |
| `auto-backup.service` | `0 * * * *` | Hourly | Enrol every non-admin user on the default backup policy, then write each user's due automatic backup, promote weekly/monthly copies, enforce retention |
| `action-history.service` | `0 3 * * *` | Daily 3 AM | Delete undo-log entries past their retention window |
| `job-claim.service` | `0 04 * * *` | Daily 4 AM | Delete job-claim/lease rows past the retention window (idempotent across replicas) |
| `holdings.service` | `30 * * * *` | Hourly at :30 | Apply matured fixed-term investment holdings |
| `emergency-access-monitor.service` | `0 09 * * *` | Daily 9 AM | Advance emergency-access requests past their waiting period and notify |
| `updates.service` | `0 0-23/12 * * *` | Every 12 hours | Refresh the cached latest-release metadata for the What's New digest |
| `attachment-orphan-sweeper.service` | `0 0-23/1 * * *` | Hourly | Delete attachment bytes whose metadata is gone, and objects left by an abandoned upload; retains a swept upload intent for its late-write quarantine (no-op for the `database` provider) |

## Emergency access

The 9 AM sweep does three separable things, and the order matters. **Revocation runs
first**, ahead of both delivery gates: voiding a returned owner's outstanding links needs
only the database, and an install whose SMTP or encryption key has gone away must still be
able to kill a link it already delivered. The SMTP and `ENCRYPTION_KEY` gates then stop
the *delivery* sweep, which is inert rather than failing per contact.

**Delivery is derived, not scheduled.** A grant advances the owner's
`emergency_access_settings.grant_generation`, and a contact whose
`notified_grant_generation` is behind it is owed a link -- whatever caused it: a replica
killed mid-send, an SMTP failure only some recipients hit, a contact added after the grant
fired, or an owner re-arming the feature. Nothing has to remember to enqueue a retry, which
is the property that makes it hold. The credential is held encrypted while the notice is
owed, so a retry re-sends the *same* link rather than minting one that kills what is
already in the recipient's inbox.

### Rolling deployments and rollback

Migration 151 installs a trigger that refuses a *generation-blind* token rotation -- a new
`claim_token_hash` written without touching `claim_token_ciphertext` or
`notified_grant_generation` -- in exactly two states: an undelivered credential in flight,
or a live delivered link. Only the pre-149 binary writes that shape, so the trigger is what
stops a stale pod from killing a link the new protocol has already delivered during a
rolling deploy.

The cost is on the way back. **After a rollback to the previous release the trigger stays**
(migrations do not revert), so that binary's grant loop raises for any owner holding a live
or in-flight link. Its per-contact `try`/`catch` logs the refusal and retries the next day,
which is loud; the alternative is a silently dead link during an account recovery. If you
must roll back and clear it, drop the trigger by hand:

```sql
DROP TRIGGER IF EXISTS trg_eac_reject_legacy_token_rotation ON emergency_access_contacts;
```

One upgrade effect worth announcing rather than discovering: migration 149 treats only a
*consumed* token as proof of delivery, so a contact who was sent a link under the previous
release and has not opened it is still owed one. The first sweep after the upgrade issues a
fresh link and the one in their inbox stops working. That is deliberate -- a link known to
work beats one nobody can confirm, and asserting delivery would disarm the safeguard
permanently -- but it is user-visible.

Every row above is checked against the source by `backend/src/common/cron-doc.spec.ts`, and
not for membership only: the Cron column is compared verbatim -- timezone included -- against
the `@Cron` decorators, one row per handler. A service with an undocumented handler fails the
suite, so does a row naming a service that has none, and so does a row whose expression
contradicts the decorator's. Six handlers -- including this file's own subject, the automatic
backup -- were absent before that guard existed, and one row claimed a midnight schedule for
an hourly job; `backend/CLAUDE.md` sends readers here for the full schedule.
