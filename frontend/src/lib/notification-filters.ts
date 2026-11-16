import type {
  NotificationFilterCategory,
  NotificationSeverity,
  NotificationType,
  Notification,
} from '@/types/notification';
import { SYSTEM_NOTIFICATION_TYPES } from '@/types/notification';

/**
 * The notification panel's active filter. `null` on a dimension means that dimension
 * is unfiltered. The same object travels on the delete-all command, so what
 * the user sees matching and what the server dismisses are classified by one
 * rule (`SYSTEM_NOTIFICATION_TYPES`, contract-tested against the backend's copy).
 */
export interface NotificationFilters {
  severity: NotificationSeverity | null;
  category: NotificationFilterCategory | null;
}

export const NO_NOTIFICATION_FILTERS: NotificationFilters = { severity: null, category: null };

export function notificationFilterCategory(type: NotificationType): NotificationFilterCategory {
  return SYSTEM_NOTIFICATION_TYPES.includes(type) ? 'system' : 'financial';
}

export function hasActiveNotificationFilters(filters: NotificationFilters): boolean {
  return filters.severity !== null || filters.category !== null;
}

export function matchesNotificationFilters(
  notification: Notification,
  filters: NotificationFilters,
): boolean {
  if (filters.severity !== null && notification.severity !== filters.severity) {
    return false;
  }
  if (
    filters.category !== null &&
    notificationFilterCategory(notification.type) !== filters.category
  ) {
    return false;
  }
  return true;
}
