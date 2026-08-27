import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MAX_REMINDER_DAYS_BEFORE } from './scheduled-reminder-bounds';

/**
 * One bound, three places that have to agree: this constant, the backend's DTO
 * ceiling, and the column's CHECK.
 *
 * The client mirror exists so the form refuses what the server refuses; a mirror
 * nothing checks is how the two drift, and the drift only shows up as a raw 400
 * on a value the form accepted.
 */
const repoRoot = join(__dirname, '..', '..', '..');

const read = (relative: string): string =>
  readFileSync(join(repoRoot, relative), 'utf8');

describe('the reminder notice-period bound', () => {
  it('matches the backend constant', () => {
    const source = read(
      'backend/src/scheduled-transactions/reminder-window.ts',
    );
    const declared = source.match(
      /export const MAX_REMINDER_DAYS_BEFORE = (\d+);/,
    );
    expect(declared).not.toBeNull();
    expect(Number(declared![1])).toBe(MAX_REMINDER_DAYS_BEFORE);
  });

  it('matches the column constraint', () => {
    const schema = read('database/schema.sql');
    const check = schema.match(
      /CONSTRAINT chk_scheduled_reminder_days_before CHECK \(\s*reminder_days_before IS NULL OR \(reminder_days_before BETWEEN 0 AND (\d+)\)\s*\)/,
    );
    expect(check).not.toBeNull();
    expect(Number(check![1])).toBe(MAX_REMINDER_DAYS_BEFORE);
  });

  it('is the ceiling the form actually applies', () => {
    // Both halves: the schema that validates the submit and the input that stops
    // the typing. A `min` without a `max` is what sent the raw 400.
    const form = read(
      'frontend/src/components/scheduled-transactions/ScheduledTransactionForm.tsx',
    );
    expect(form).toContain('.max(MAX_REMINDER_DAYS_BEFORE');
    const reminderInputs = form.split("label={t('form.remindDaysBeforeLabel')}");
    // One leading chunk plus one per input.
    expect(reminderInputs.length).toBeGreaterThan(1);
    for (const chunk of reminderInputs.slice(1)) {
      expect(chunk.slice(0, 400)).toContain('max={MAX_REMINDER_DAYS_BEFORE}');
    }
  });
});
