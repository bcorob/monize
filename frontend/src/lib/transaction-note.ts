/**
 * How long the free-text note on a transaction may be.
 *
 * The server's copy is `backend/src/common/transaction-note.ts`, and the two
 * must agree: below it a form truncates text the user may legitimately store,
 * above it the form accepts a save the server then rejects. That second case is
 * why this exists -- the main transaction form had no cap at all, so a long
 * description came back as a bare 400 with nothing pointing at the field, while
 * `BulkUpdateModal` (the one form that did cap) reported it properly.
 *
 * `backend/src/common/transaction-note.contract.spec.ts` reads this file and
 * fails when the numbers differ; `src/test/transaction-note.guard.test.ts`
 * fails when a note field on any form is missing the cap.
 */
export const TRANSACTION_NOTE_MAX_LENGTH = 750;
