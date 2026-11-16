'use client';

import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { useAuthStore } from '@/store/authStore';
import { useTranslations } from 'next-intl';
import toast from 'react-hot-toast';
import { useClickOutside } from '@/hooks/useClickOutside';
import { TOUR_ANCHORS, tourAnchor } from '@/lib/tours/anchors';
import { useTourOpensNotificationBell } from '@/store/tourStore';
import { notificationsApi } from '@/lib/notifications';
import {
  NotificationFilters,
  NO_NOTIFICATION_FILTERS,
  hasActiveNotificationFilters,
  matchesNotificationFilters,
} from '@/lib/notification-filters';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import type { Notification } from '@/types/notification';
import { NotificationList } from './NotificationList';
import {
  NotificationChildModalContext,
  type NotificationChildModalRegistry,
} from './RemindMeButton';

export function NotificationBell() {
  const actingAsUserId = useAuthStore((s) => s.actingAsUserId);
  const userId = useAuthStore((s) => s.user?.id);
  const budgetsGranted = useAuthStore((s) => s.delegateSections?.budgets);
  if (actingAsUserId && !budgetsGranted) return null;
  // Changing identity unmounts the old feed and cancels its delayed dismissals.
  return <NotificationBellContent key={`${userId}:${actingAsUserId}`} canManage={!actingAsUserId} />;
}

function NotificationBellContent({ canManage }: { canManage: boolean }) {
  const t = useTranslations('notifications');
  const [notifications, setAlerts] = useState<Notification[]>([]);
  const [isOpen, setIsOpen] = useState(false);
  // The feed is read on mount, so it starts out loading.
  const [isLoading, setIsLoading] = useState(true);
  const [dismissingIds, setDismissingIds] = useState<Set<string>>(new Set());
  const [collapsingIds, setCollapsingIds] = useState<Set<string>>(new Set());
  const [filters, setFilters] = useState<NotificationFilters>(NO_NOTIFICATION_FILTERS);
  const [confirmingDeleteAll, setConfirmingDeleteAll] = useState(false);
  // A child modal opened from a row (the Remind me dialog) portals to
  // document.body, so its own clicks land outside this panel. Count the open
  // ones and treat the panel as owning them: while any is open, the panel's
  // click-outside is off, so dismissing the dialog returns to the list rather
  // than closing the panel behind it -- the same boundary the ConfirmDialog
  // already gets through `confirmingDeleteAll`.
  const [openChildModalCount, setOpenChildModalCount] = useState(0);
  const registerOpenModal = useCallback<
    NotificationChildModalRegistry['registerOpenModal']
  >(() => {
    setOpenChildModalCount((count) => count + 1);
    return () => setOpenChildModalCount((count) => Math.max(0, count - 1));
  }, []);
  const childModalRegistry = useMemo<NotificationChildModalRegistry>(
    () => ({ registerOpenModal }),
    [registerOpenModal],
  );
  const childModalOpen = openChildModalCount > 0;
  const dropdownRef = useRef<HTMLDivElement>(null);
  // A tour step can ask for the panel to stay open so it can describe what is
  // inside; that wins over local state (and over the click-outside close), the
  // same way the header's Tools dropdown handles it.
  const tourOpensPanel = useTourOpensNotificationBell();
  const panelOpen = isOpen || tourOpensPanel;
  const undoTimers = useRef<Map<string, NodeJS.Timeout>>(new Map());

  // The bell's count is about every notification, not the filtered view.
  const unreadCount = notifications.filter((a) => !a.isRead && !dismissingIds.has(a.id)).length;
  const visibleNotifications = notifications.filter((a) => matchesNotificationFilters(a, filters));

  // The writes live in the inner `run`, so they happen after the request, not during the effect.
  const fetchAlerts = useCallback(() => {
    const run = async () => {
      try {
        const data = await notificationsApi.list();
        setAlerts(data);
      } catch {
        // Silently fail on notification fetch
      } finally {
        setIsLoading(false);
      }
    };
    return run();
  }, []);

  useEffect(() => {
    fetchAlerts();
  }, [fetchAlerts]);

  // The confirm dialog portals to document.body, so its clicks land outside
  // the dropdown ref; without the gate, confirming would first close the panel.
  useClickOutside(dropdownRef, () => setIsOpen(false), {
    enabled: !confirmingDeleteAll && !childModalOpen,
  });

  const handleMarkRead = async (notificationId: string) => {
    try {
      await notificationsApi.markRead(notificationId);
      setAlerts((prev) =>
        prev.map((a) => (a.id === notificationId ? { ...a, isRead: true } : a)),
      );
    } catch {
      // Silently fail
    }
  };

  const handleMarkAllRead = async () => {
    try {
      await notificationsApi.markAllRead();
      setAlerts((prev) => prev.map((a) => ({ ...a, isRead: true })));
    } catch {
      // Silently fail
    }
  };

  // Clean up timers on unmount
  useEffect(() => {
    const timers = undoTimers.current;
    return () => {
      timers.forEach((timer) => clearTimeout(timer));
    };
  }, []);

  const handleDismiss = (notificationId: string) => {
    // Enter undo phase - show "Undo" in place of the notification content
    setDismissingIds((prev) => new Set(prev).add(notificationId));

    // After 5 seconds, start collapse animation then remove
    const timer = setTimeout(() => {
      setDismissingIds((prev) => {
        const next = new Set(prev);
        next.delete(notificationId);
        return next;
      });
      setCollapsingIds((prev) => new Set(prev).add(notificationId));

      // After collapse animation completes, remove from array + API call.
      // Tracked under the same key, replacing the outer timer rather than
      // dropping it: the map is what unmount cleanup and "dismiss all" cancel
      // through, so an untracked timer ran on a torn-down component and sent a
      // dismiss for a row the bulk request had already covered.
      const collapse = setTimeout(() => {
        undoTimers.current.delete(notificationId);
        setCollapsingIds((prev) => {
          const next = new Set(prev);
          next.delete(notificationId);
          return next;
        });
        setAlerts((prev) => prev.filter((a) => a.id !== notificationId));
        notificationsApi.dismiss(notificationId).catch(() => {});
      }, 300);
      undoTimers.current.set(notificationId, collapse);
    }, 5000);

    undoTimers.current.set(notificationId, timer);
  };

  const handleUndoDismiss = (notificationId: string) => {
    const timer = undoTimers.current.get(notificationId);
    if (timer) {
      clearTimeout(timer);
      undoTimers.current.delete(notificationId);
    }
    setDismissingIds((prev) => {
      const next = new Set(prev);
      next.delete(notificationId);
      return next;
    });
  };

  /**
   * Dismiss everything matching the active filter, server-side. The filter
   * itself travels on the command, so it also reaches matching notifications beyond
   * the fetched window -- the toast reports the server's count, which can be
   * more than the rows that were on screen.
   */
  const handleConfirmDeleteAll = async () => {
    setConfirmingDeleteAll(false);
    try {
      const { dismissed } = await notificationsApi.dismissAll({
        severity: filters.severity ?? undefined,
        category: filters.category ?? undefined,
      });
      const removed = notifications.filter((a) => matchesNotificationFilters(a, filters));
      for (const notification of removed) {
        const timer = undoTimers.current.get(notification.id);
        if (timer) {
          clearTimeout(timer);
          undoTimers.current.delete(notification.id);
        }
      }
      const removedIds = new Set(removed.map((a) => a.id));
      setDismissingIds((prev) => new Set([...prev].filter((id) => !removedIds.has(id))));
      setCollapsingIds((prev) => new Set([...prev].filter((id) => !removedIds.has(id))));
      setAlerts((prev) => prev.filter((a) => !matchesNotificationFilters(a, filters)));
      toast.success(t('deleted', { count: dismissed }));
    } catch {
      toast.error(t('deleteFailed'));
    }
  };

  return (
    <div className="relative" ref={dropdownRef}>
      <button
        {...tourAnchor(TOUR_ANCHORS.notificationBell)}
        onClick={() => setIsOpen(!isOpen)}
        className="relative p-2 text-gray-600 dark:text-gray-300 hover:text-gray-900 dark:hover:text-gray-100 hover:bg-gray-100 dark:hover:bg-gray-700 rounded-md transition-colors"
        title={t('buttonTitle')}
        aria-label={t('buttonAriaLabel')}
        data-testid="notification-badge-button"
      >
        <svg
          xmlns="http://www.w3.org/2000/svg"
          fill="none"
          viewBox="0 0 24 24"
          strokeWidth={1.5}
          stroke="currentColor"
          className="w-5 h-5"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M14.857 17.082a23.848 23.848 0 0 0 5.454-1.31A8.967 8.967 0 0 1 18 9.75V9A6 6 0 0 0 6 9v.75a8.967 8.967 0 0 1-2.312 6.022c1.733.64 3.56 1.085 5.455 1.31m5.714 0a24.255 24.255 0 0 1-5.714 0m5.714 0a3 3 0 1 1-5.714 0"
          />
        </svg>
        {unreadCount > 0 && (
          <span
            className="absolute -top-0.5 -right-0.5 flex items-center justify-center w-4 h-4 text-[10px] font-bold text-white bg-red-500 rounded-full"
            data-testid="unread-count"
          >
            {unreadCount > 9 ? '9+' : unreadCount}
          </span>
        )}
      </button>

      {panelOpen && (
        <NotificationChildModalContext.Provider value={childModalRegistry}>
          <NotificationList
            canManageNotifications={canManage}
            notifications={visibleNotifications}
            isLoading={isLoading}
            onMarkRead={handleMarkRead}
            onMarkAllRead={handleMarkAllRead}
            onDismiss={handleDismiss}
            onUndoDismiss={handleUndoDismiss}
            dismissingIds={dismissingIds}
            collapsingIds={collapsingIds}
            onClose={() => setIsOpen(false)}
            filters={filters}
            onFiltersChange={setFilters}
            onDeleteAll={() => setConfirmingDeleteAll(true)}
          />
        </NotificationChildModalContext.Provider>
      )}

      <ConfirmDialog
        isOpen={confirmingDeleteAll}
        title={t('deleteAllConfirmTitle')}
        message={
          hasActiveNotificationFilters(filters)
            ? t('deleteAllConfirmMessageFiltered')
            : t('deleteAllConfirmMessageAll')
        }
        variant="danger"
        onConfirm={handleConfirmDeleteAll}
        onCancel={() => setConfirmingDeleteAll(false)}
      />
    </div>
  );
}
