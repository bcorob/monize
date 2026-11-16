import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  REMINDER_MIN_INTERVAL_MINUTES,
  REMINDER_INTERVAL_PRESETS,
} from './notification-reminders';

/**
 * The reminder interval floor is mirrored by hand across the layers (nothing
 * compiles the frontend against the backend). If the backend moves the floor and
 * this constant does not, the picker offers an interval the server clamps -- so
 * hold the two equal, and hold every preset at or above the floor so the UI never
 * offers a value that will be silently rounded up.
 */
const BACKEND_CONSTANTS = resolve(
  __dirname,
  '../../../backend/src/notification-center/notification-reminder.constants.ts',
);

function parseBackendMinInterval(): number {
  const source = readFileSync(BACKEND_CONSTANTS, 'utf8');
  const match = source.match(
    /REMINDER_MIN_INTERVAL_MINUTES\s*=\s*(\d+)/,
  );
  if (!match) throw new Error('backend REMINDER_MIN_INTERVAL_MINUTES not found');
  return Number(match[1]);
}

describe('notification reminders contract', () => {
  it('mirrors the backend minimum interval', () => {
    expect(REMINDER_MIN_INTERVAL_MINUTES).toBe(parseBackendMinInterval());
  });

  it('never offers a preset below the floor', () => {
    for (const preset of REMINDER_INTERVAL_PRESETS) {
      expect(preset).toBeGreaterThanOrEqual(REMINDER_MIN_INTERVAL_MINUTES);
    }
  });
});
