# Spec: a notification about a deleted transaction is deleted with it

Status: **proposed, awaiting maintainer approval.** Scope from the maintainer's
answer to #1291 open question 19: "If the transaction that drives an event is
deleted, then the event should go too" (recorded in
`notification-preferences.md` Section 16.3).

Owner: notification-center. Related: #1291, INV-NOTIFY-001 (the write door),
`notification-preferences.md` Section 16.4.

---

## 1. What this is, and what it is not

The maintainer's rule: a notification whose **subject is a specific ledger
transaction** must not outlive that transaction. When the transaction is deleted,
its notification goes too.

Two facts from the code map bound this precisely:

1. **No notification today references a ledger `transactions.id`.** Every current
   producer that mentions a "transaction" references a **scheduled** transaction
   (`billId` / `scheduledId` inside the `data` JSONB, which are
   `scheduled_transactions.id`), never a posted ledger row. `notifications` has no
   `transaction_id` column; its only FK columns are `user_id`, `budget_id`,
   `budget_category_id`.
2. **`transactions.remove()` has no path into the notifications table.** The only
   existing coupling between a notification's lifecycle and anything else is
   `notification_reminders.source_notification_id ON DELETE SET NULL` (a reminder
   outlives its source by design) and `purgeOld` (retention).

So this is **forward-looking infrastructure plus a contract**, not a fix to a
current leak: it gives future "about this transaction" producers (e.g. a
hypothetical "large transaction posted", or any alert whose `target` is
`/transactions/:id`) a place to record the link and a guarantee that the link is
honored on delete. Until such a producer exists, the mechanism is a **no-op on
every real row** (every `source_transaction_id` is `NULL`).

This is **not** a cascade for state-derived alerts. A balance-threshold alert
(`balance-threshold-notifications.md`) is about the account's *state*, which was
genuinely below threshold at fire time; the transaction that pushed it there is
not its subject. Deleting that transaction recomputes the balance and the
balance producer re-evaluates on the delete (a delete is a balance-moving write)
and re-arms -- so balance alerts do **not** set `source_transaction_id`. Only a
producer whose subject *is* the transaction sets it.

---

## 2. Invariants

- **INV-NOTIFY-TXN-001 (subject-linked, delete-cascaded).** A notification linked
  to a ledger transaction via `source_transaction_id` is removed in the **same
  database transaction** that deletes the transaction. The mechanism is a foreign
  key `ON DELETE CASCADE`, so the removal is atomic with the delete and needs no
  application sweep and has no window in which the notification is orphaned.
- **INV-NOTIFY-TXN-002 (opt-in link).** The column is `NULL` unless a producer
  whose subject is that transaction sets it. A `NULL` FK cascades nothing, so
  existing producers (all of them, today) are unaffected. A producer sets the
  link only when the notification's `target` is that transaction.
- **INV-NOTIFY-TXN-003 (cascade delete is not a write-door write).** The cascade
  removes rows; it does not create them. INV-NOTIFY-001 governs the *shape* of a
  created row (bounds, conflict, one writer); a DB-level `ON DELETE CASCADE` is a
  sanctioned delete path -- the same class as delete-my-data and `purgeOld`, which
  are delete paths outside the write-door scan rather than named entries in
  INV-NOTIFY-001's allowlist (that allowlist names only the door, delete-my-data and
  the restore's dynamic insert) -- and it does not open a second writer.
- **INV-NOTIFY-TXN-004 (reminders follow their source, not the transaction).** A
  reminder is linked to a notification (`source_notification_id ON DELETE SET
  NULL`), never directly to a transaction. When a transaction cascade-deletes a
  linked notification, that notification's reminders take their existing
  source-deleted path (the nag stops); no reminder gains a transaction FK.

---

## 3. Shape

### 3.1 New column and FK on `notifications`

```
source_transaction_id  UUID  NULL  REFERENCES transactions(id) ON DELETE CASCADE
```

plus a partial index for the cascade's reverse lookup and for the producer's own
dedupe reads:

```
CREATE INDEX idx_notifications_source_transaction
  ON notifications (source_transaction_id)
  WHERE source_transaction_id IS NOT NULL;
```

`notifications` is user-owned and already under RLS; the column and index ship in
the same migration, `schema.sql` in sync. The RLS enumeration count in
`schema.sql` is unchanged (no new policy -- the table's policy already covers the
column). Because the FK target `transactions` is itself RLS-scoped to the same
`user_id`, the cascade never crosses a tenant boundary (a transaction and its
notification share `user_id` by construction; the producer sets the link only for
the owner's own transaction).

### 3.2 The write door accepts the link

`CreateNotificationInput` gains `sourceTransactionId?: string | null`, and
`NotificationService.create` writes it (bounded like the other columns -- a UUID
or `NULL`, no truncation needed). This keeps the single-writer invariant: the
link is set only through the one door, never by a producer reaching around it.

### 3.3 The producer contract (for future "about a transaction" producers)

A producer whose subject is a ledger transaction:

- sets `sourceTransactionId: txId` and a `target` that resolves to a **real route**.
  There is no per-transaction App Router page today (`/transactions` is a list, not
  `/transactions/:id`), so such a producer either targets `/transactions` (with the
  row filtered client-side) or ships the `/transactions/:id` route as part of its own
  scope. The earlier draft's literal `` `/transactions/${txId}` `` would fail
  `notification-target.contract.test.ts`, which asserts every producer target
  resolves; this is corrected here.
- when the producer does target a per-transaction route, that `target` and
  `sourceTransactionId` must agree -- `notification-target.contract.test.ts` is
  extended so that a notification carrying `sourceTransactionId` has a `target` that
  resolves to that transaction, and vice versa (a source-scan/contract, so a producer
  cannot set one without the other).

No such producer ships in this spec; the contract is stated so the first one
built lands with the link and the guard already in place.

### 3.4 What the delete path does (nothing new in code)

`transactions.remove()` is **unchanged**: the `m.delete(Transaction, { id,
userId })` it already runs triggers the FK cascade inside its existing
`withScopedDb` transaction. There is no new query in the transaction service and
no new coupling to maintain -- the database enforces the invariant. (This is the
"a rule the machine can check" preference at its strongest: a foreign key, not a
paragraph asking every delete path to remember.)

---

## 4. Interaction with existing couplings

- **`purgeOld`** (retention, `@Cron`): unaffected. It deletes dismissed/old rows;
  the cascade deletes transaction-linked rows on transaction delete. They do not
  overlap (a cascade-deleted row is simply gone before retention would consider
  it).
- **`source_notification_id ON DELETE SET NULL`**: unchanged. If a
  transaction-linked notification is cascade-deleted and it happened to be a
  reminder's source, the reminder's existing `SET NULL` path fires (the nag
  stops). The two FKs compose correctly: the transaction cascade removes the
  notification, which nulls the reminder's source, which stops the reminder --
  all within the delete's transaction for the notification, and the reminder's
  own sweep thereafter.
- **Restore**: the restore's dependency order (`restore-plan.ts`) already inserts
  `transactions` before `notifications` for the existing FKs; the new FK adds no
  new ordering constraint (same parent table). A restored notification whose
  `source_transaction_id` points at a transaction not in the archive would violate
  the FK -- but the restore inserts transactions first and both belong to the same
  user's export, so the parent is present. `restore-plan.spec.ts` (CI-owned)
  proves the order against the schema.

---

## 5. Deliberate trades

- **`ON DELETE CASCADE`, not `SET NULL`.** The maintainer's intent is that the
  event *goes*, not that it lingers pointing at nothing. This is the opposite
  choice from `source_notification_id` (SET NULL) because the semantics differ: a
  reminder is allowed to outlive its source (it re-emits a subject), but a
  notification *about* a deleted transaction is about nothing.
- **DB cascade, not an application sweep in `remove()`.** A sweep would be a
  second place to keep correct across every delete path (split parent, transfer
  legs, bulk delete) -- exactly the multi-path hazard the codebase repeatedly
  warns about. The FK is enforced once, by the database, on every path that
  deletes the row.
- **Ships as a no-op.** Adding the column now, ahead of the first producer that
  uses it, means the first such producer does not also have to add a migration and
  can rely on the guard already existing. The cost is a nullable column that is
  `NULL` on every current row.

---

## 6. Open decisions (maintainer confirms before build)

- **D1. Build now vs with the first producer.** This spec can land as
  infrastructure (column + FK + door field + guard), or be deferred until the
  first "about a transaction" producer is specced and built together. Default:
  land the infrastructure now, since it is a no-op and unblocks the first
  producer cleanly.
- **D2. Reminders directly linked to a transaction?** Default **no** -- a reminder
  links to a notification, and the notification links to the transaction, so a
  transaction delete reaches the reminder transitively (INV-NOTIFY-TXN-004). A
  direct `notification_reminders.source_transaction_id` is only needed if a
  reminder can exist without a source notification, which it cannot today.
- **D3. Which future producers set the link.** Named per-producer in each
  producer's own spec (e.g. a "large transaction posted" alert). Not decided here.

---

## 7. Test matrix

Unit / source-scan (offline):
1. **Door writes the link**: `create` with `sourceTransactionId` persists it;
   without it, the column is `NULL` (INV-NOTIFY-TXN-002).
2. **Target/link agreement** (INV-NOTIFY-TXN-003 contract): a notification with
   `sourceTransactionId` set has a `target` resolving to that transaction; the
   contract test fails if one is set without the other.
3. **Write door** (INV-NOTIFY-001): still one writer; the new column does not add
   an INSERT path.
4. **No current producer sets it**: a scan asserts every existing producer leaves
   `sourceTransactionId` unset (they reference scheduled ids, not ledger ids), so
   the cascade is a no-op on today's rows.

Integration (CI-owned, real database):
5. **Cascade on delete** (INV-NOTIFY-TXN-001): a notification with
   `source_transaction_id` set is gone after `transactions.remove()` of that
   transaction, in one transaction, with no orphan window -- tested through every
   delete path (single row, split parent, transfer legs, bulk delete).
6. **Composition with reminders** (INV-NOTIFY-TXN-004): a reminder whose source is
   a transaction-linked notification stops when the transaction is deleted.
7. **RLS + schema drift**: the column and FK replay as a no-op on `schema.sql`;
   the cascade never crosses a tenant (parent and child share `user_id`).
