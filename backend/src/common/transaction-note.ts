/**
 * How long the free-text note on a transaction may be.
 *
 * One number for the whole family -- a transaction's `description`, a split's
 * `memo`, and the scheduled, transfer, investment and override forms of both --
 * because they are one field to the person typing in them. A split memo capped
 * shorter than its parent's description is a rejection the user cannot explain,
 * and the cap had already been spelled out thirteen times, which is how such a
 * difference arrives without anyone choosing it.
 *
 * The columns behind these are all `TEXT` (see `database/schema.sql`), so this
 * is a product decision about how much a person should type, not a storage
 * limit -- raising it needs no migration. It moved from 500 to 750 when
 * descriptions started rendering their web addresses as links: a ticket or
 * order URL is routinely 100+ characters, and 500 left no room for the note
 * that says what the link is.
 *
 * `frontend/src/lib/transaction-note.ts` carries the same number so a form can
 * stop the user at the limit instead of letting the server reject the save;
 * `transaction-note.contract.spec.ts` fails when the two layers disagree, and
 * when a DTO in the family spells the number out again.
 */
export const TRANSACTION_NOTE_MAX_LENGTH = 750;
