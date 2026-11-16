import { describe, it, expect } from 'vitest';
import type { Notification } from '@/types/notification';
import {
  NO_NOTIFICATION_FILTERS,
  notificationFilterCategory,
  hasActiveNotificationFilters,
  matchesNotificationFilters,
} from './notification-filters';

const makeNotification = (overrides: Partial<Notification> = {}): Notification => ({
  id: 'notification-1',
  userId: 'user-1',
  budgetId: 'budget-1',
  budgetCategoryId: 'bc-1',
  type: 'THRESHOLD_WARNING',
  severity: 'warning',
  title: 'Groceries reaching budget limit',
  message: 'You have used 85% of your Groceries budget.',
  data: {},
  isRead: false,
  isEmailSent: false,
  periodStart: '2026-02-01',
  createdAt: new Date().toISOString(),
  ...overrides,
});

describe('notificationFilterCategory', () => {
  it('classifies system notification types as system', () => {
    expect(notificationFilterCategory('BACKUP_FAILED')).toBe('system');
    expect(notificationFilterCategory('SMTP_FAILURE')).toBe('system');
  });

  it('classifies everything else as financial, BILL_DUE and SCHEDULED_POST_FAILED included', () => {
    expect(notificationFilterCategory('BILL_DUE')).toBe('financial');
    // A scheduled-post failure is about the user's own scheduled payment, so it
    // reads as financial in the list's system/financial split (it is PAYMENTS).
    expect(notificationFilterCategory('SCHEDULED_POST_FAILED')).toBe('financial');
    expect(notificationFilterCategory('OVER_BUDGET')).toBe('financial');
    expect(notificationFilterCategory('POSITIVE_MILESTONE')).toBe('financial');
  });
});

describe('hasActiveNotificationFilters', () => {
  it('is false with nothing selected', () => {
    expect(hasActiveNotificationFilters(NO_NOTIFICATION_FILTERS)).toBe(false);
  });

  it('is true when either dimension is set', () => {
    expect(hasActiveNotificationFilters({ severity: 'info', category: null })).toBe(true);
    expect(hasActiveNotificationFilters({ severity: null, category: 'system' })).toBe(true);
  });
});

describe('matchesNotificationFilters', () => {
  it('matches everything with no filter active', () => {
    expect(matchesNotificationFilters(makeNotification(), NO_NOTIFICATION_FILTERS)).toBe(true);
  });

  it('filters on severity', () => {
    const filters = { severity: 'critical' as const, category: null };
    expect(matchesNotificationFilters(makeNotification({ severity: 'critical' }), filters)).toBe(true);
    expect(matchesNotificationFilters(makeNotification({ severity: 'warning' }), filters)).toBe(false);
  });

  it('filters on category', () => {
    const filters = { severity: null, category: 'system' as const };
    expect(
      matchesNotificationFilters(makeNotification({ type: 'BACKUP_FAILED' }), filters),
    ).toBe(true);
    expect(
      matchesNotificationFilters(makeNotification({ type: 'BILL_DUE' }), filters),
    ).toBe(false);
  });

  it('requires both dimensions when both are set', () => {
    const filters = { severity: 'critical' as const, category: 'system' as const };
    expect(
      matchesNotificationFilters(
        makeNotification({ type: 'BACKUP_FAILED', severity: 'critical' }),
        filters,
      ),
    ).toBe(true);
    expect(
      matchesNotificationFilters(
        makeNotification({ type: 'BACKUP_FAILED', severity: 'warning' }),
        filters,
      ),
    ).toBe(false);
    expect(
      matchesNotificationFilters(
        makeNotification({ type: 'OVER_BUDGET', severity: 'critical' }),
        filters,
      ),
    ).toBe(false);
  });
});
