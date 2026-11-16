import { describe, it, expect } from 'vitest';
import { TRANSACTION_NOTE_MAX_LENGTH } from '@/lib/transaction-note';

/**
 * Every form that takes a transaction's note stops the user at the limit.
 *
 * The server has always capped these fields; the client capped exactly one of
 * them. So typing past the limit in the main transaction form produced a bare
 * 400 with nothing pointing at the field -- while `BulkUpdateModal`, the one
 * form with a `.max()`, reported it properly. That asymmetry is the defect: a
 * cap the user cannot see coming is a cap that loses their text.
 *
 * The counterpart on the server (`backend/src/common/transaction-note.contract.spec.ts`)
 * scans the DTOs and the two AI tool layers, and checks this file's number
 * against its own.
 */

const sources = import.meta.glob('/src/**/*.{ts,tsx}', {
  query: '?raw',
  eager: true,
  import: 'default',
}) as Record<string, string>;

/**
 * The forms that write a transaction note, and the field each one takes. Named
 * rather than discovered, because "is this input a transaction note" is a
 * judgement -- a security's description and a budget's are the same word for a
 * different thing, and they answer to their own limits.
 */
const NOTE_FORMS: Record<string, string> = {
  '/src/components/transactions/TransactionForm.tsx': "a transaction's description",
  '/src/components/transactions/SplitTransactionFields.tsx':
    "a split parent's description",
  '/src/components/transactions/SplitEditor.tsx': 'the memo on each split line',
  '/src/components/transactions/BulkUpdateModal.tsx':
    'the description written across a selection',
  '/src/components/scheduled-transactions/ScheduledTransactionForm.tsx':
    "a schedule's description",
  '/src/components/scheduled-transactions/PostTransactionDialog.tsx':
    'the description on the posting being confirmed',
  '/src/components/scheduled-transactions/OverrideEditorDialog.tsx':
    "one occurrence's description",
  '/src/components/investments/InvestmentTransactionForm.tsx':
    "an investment transaction's description",
};

function withoutComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (match) => match.replace(/[^\n]/g, ' '))
    .replace(
      /(^|[^:])\/\/[^\n]*/g,
      (match, before: string) => before + ' '.repeat(match.length - before.length),
    );
}

describe('a transaction note is capped where it is typed', () => {
  it('caps every note field through the shared constant', () => {
    for (const [path, field] of Object.entries(NOTE_FORMS)) {
      const source = sources[path];
      expect(source, `${path} not found -- update NOTE_FORMS`).toBeTruthy();
      expect(
        withoutComments(source),
        `${path} takes ${field} without maxLength={TRANSACTION_NOTE_MAX_LENGTH}`,
      ).toContain('maxLength={TRANSACTION_NOTE_MAX_LENGTH}');
    }
  });

  it('caps each note input in a form that has more than one', () => {
    // Two of these render the field twice (a compact row and a full-width
    // block), and capping only the one that happened to be on screen during
    // testing is exactly how half a form ends up enforcing nothing.
    const occurrences = (path: string) =>
      withoutComments(sources[path]).match(/maxLength=\{TRANSACTION_NOTE_MAX_LENGTH\}/g)
        ?.length ?? 0;
    expect(occurrences('/src/components/transactions/SplitEditor.tsx')).toBe(2);
    expect(
      occurrences('/src/components/scheduled-transactions/ScheduledTransactionForm.tsx'),
    ).toBe(2);
    expect(
      occurrences('/src/components/scheduled-transactions/PostTransactionDialog.tsx'),
    ).toBe(2);
  });

  it('writes the number nowhere but the constant', () => {
    // A literal beside the constant is how the two drift apart at the next
    // change -- which is this change: 500 became 750. Scoped to the note forms
    // on purpose: a budget's description caps at 1000 and a security's at its
    // own length, and those are their limits to keep, not copies of this one.
    const offenders = Object.keys(NOTE_FORMS)
      .filter((path) => {
        const source = withoutComments(sources[path]);
        return (
          /maxLength=\{\s*\d+\s*\}/.test(source) ||
          /\b(?:description|memo):\s*z\s*\.string\(\)\s*\.max\(\s*\d+\s*\)/.test(source)
        );
      });
    expect(offenders).toEqual([]);
  });

  it('is a number a person can actually reach', () => {
    // A guard that passed with the cap set to 0 would be worse than none.
    expect(TRANSACTION_NOTE_MAX_LENGTH).toBeGreaterThan(500);
    expect(Number.isInteger(TRANSACTION_NOTE_MAX_LENGTH)).toBe(true);
  });
});
