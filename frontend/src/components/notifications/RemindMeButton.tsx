'use client';

import { createContext, useContext, useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import toast from 'react-hot-toast';
import { BellAlertIcon, BellSlashIcon } from '@heroicons/react/24/outline';

import { Modal } from '@/components/ui/Modal';
import { createLogger } from '@/lib/logger';
import type { Notification } from '@/types/notification';
import {
  notificationRemindersApi,
  REMINDER_INTERVAL_PRESETS,
  type ReminderRepeatMode,
} from '@/lib/notification-reminders';

const log = createLogger('RemindMeButton');

/**
 * Lets a reminder dialog tell the notification panel that owns it that a child
 * modal is open, so the panel's click-outside handling treats interactions
 * belonging to the dialog (its backdrop, X, Cancel) as inside its boundary
 * rather than closing the panel behind it. The dialog portals to
 * `document.body`, so those clicks land outside the panel's own DOM and would
 * otherwise dismiss it.
 *
 * `registerOpenModal` returns its own unregister callback, so a dialog that
 * unmounts while still open (an identity switch tearing the feed down) releases
 * its hold too. The panel provides the registry; a `null` context means the
 * button is rendered outside a panel and there is nothing to guard.
 */
export interface NotificationChildModalRegistry {
  registerOpenModal: () => () => void;
}

export const NotificationChildModalContext =
  createContext<NotificationChildModalRegistry | null>(null);

/** The reminder id a nag row carries, or null on an ordinary notification. */
function reminderIdOf(notification: Notification): string | null {
  const id = notification.data?.reminderId;
  return typeof id === 'string' && id.length > 0 ? id : null;
}

/**
 * Per-row reminder control. On an ordinary notification it opens a small dialog
 * to schedule a repeating or one-time reminder about that subject; on a row that
 * is itself a reminder re-delivery (it carries `data.reminderId`) it offers to
 * stop the reminder. The Stop control is the app-side half of R4 -- the push
 * Stop action (Phase 5) calls the same endpoint.
 */
export function RemindMeButton({ notification }: { notification: Notification }) {
  const t = useTranslations('notifications');
  const reminderId = reminderIdOf(notification);
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<ReminderRepeatMode>('repeat');
  const [interval, setInterval] = useState<number>(60);
  const [busy, setBusy] = useState(false);
  // A nag row's reminder, once stopped here, is gone until the next refetch --
  // remember it locally so the control does not offer to stop it twice.
  const [stopped, setStopped] = useState(false);

  // While the dialog is open, hold the notification panel open: without this,
  // the dialog's backdrop/X/Cancel clicks (which land outside the panel because
  // the modal portals to document.body) close the panel behind it.
  const childModalRegistry = useContext(NotificationChildModalContext);
  useEffect(() => {
    if (!open || !childModalRegistry) return;
    return childModalRegistry.registerOpenModal();
  }, [open, childModalRegistry]);

  const iconButtonClass =
    'p-1 rounded-md text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 hover:bg-gray-200 dark:hover:bg-gray-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 disabled:opacity-40';

  const handleStop = async (id: string) => {
    setBusy(true);
    try {
      await notificationRemindersApi.stop(id);
      setStopped(true);
      toast.success(t('reminder.stopped'));
    } catch (error) {
      log.error('Failed to stop reminder', error);
      toast.error(t('reminder.stopFailed'));
    } finally {
      setBusy(false);
    }
  };

  const handleCreate = async () => {
    setBusy(true);
    try {
      await notificationRemindersApi.create({
        sourceNotificationId: notification.id,
        repeatMode: mode,
        intervalMinutes: interval,
      });
      toast.success(t('reminder.created'));
      setOpen(false);
    } catch (error) {
      log.error('Failed to create reminder', error);
      toast.error(t('reminder.createFailed'));
    } finally {
      setBusy(false);
    }
  };

  if (reminderId) {
    return (
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          void handleStop(reminderId);
        }}
        disabled={busy || stopped}
        className={iconButtonClass}
        aria-label={t('reminder.stopAriaLabel')}
        title={t('reminder.stopAriaLabel')}
        data-testid={`stop-reminder-${notification.id}`}
      >
        <BellSlashIcon className="w-4 h-4" />
      </button>
    );
  }

  const intervalLabel = (minutes: number): string =>
    minutes % 60 === 0
      ? t('reminder.durationHours', { hours: minutes / 60 })
      : t('reminder.durationMinutes', { minutes });

  const optionClass = (selected: boolean): string =>
    `px-3 py-1.5 rounded-md text-sm border transition-colors motion-reduce:transition-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 ${
      selected
        ? 'bg-blue-600 text-white border-blue-600'
        : 'bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-200 border-gray-300 dark:border-gray-600 hover:bg-gray-200 dark:hover:bg-gray-600'
    }`;

  return (
    <>
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          setOpen(true);
        }}
        className={iconButtonClass}
        aria-label={t('reminder.remindAriaLabel')}
        title={t('reminder.remindAriaLabel')}
        data-testid={`remind-me-${notification.id}`}
      >
        <BellAlertIcon className="w-4 h-4" />
      </button>

      <Modal
        isOpen={open}
        onClose={() => setOpen(false)}
        pushHistory
        title={t('reminder.dialogTitle')}
        description={t('reminder.dialogDescription')}
        padding="md"
        footer={
          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="px-3 py-1.5 rounded-md text-sm text-gray-700 dark:text-gray-200 hover:bg-gray-200 dark:hover:bg-gray-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
            >
              {t('reminder.cancel')}
            </button>
            <button
              type="button"
              onClick={() => void handleCreate()}
              disabled={busy}
              className="px-3 py-1.5 rounded-md text-sm bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
              data-testid="reminder-confirm"
            >
              {t('reminder.confirm')}
            </button>
          </div>
        }
      >
        <div className="flex flex-col gap-4">
          <div>
            <p className="text-xs font-medium text-gray-500 dark:text-gray-400 mb-1.5">
              {t('reminder.modeLabel')}
            </p>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => setMode('repeat')}
                className={optionClass(mode === 'repeat')}
                aria-pressed={mode === 'repeat'}
                data-testid="reminder-mode-repeat"
              >
                {t('reminder.modeRepeat')}
              </button>
              <button
                type="button"
                onClick={() => setMode('once')}
                className={optionClass(mode === 'once')}
                aria-pressed={mode === 'once'}
                data-testid="reminder-mode-once"
              >
                {t('reminder.modeOnce')}
              </button>
            </div>
          </div>

          <div>
            <p className="text-xs font-medium text-gray-500 dark:text-gray-400 mb-1.5">
              {mode === 'once'
                ? t('reminder.intervalLabelOnce')
                : t('reminder.intervalLabelRepeat')}
            </p>
            <div className="flex flex-wrap gap-2">
              {REMINDER_INTERVAL_PRESETS.map((minutes) => (
                <button
                  key={minutes}
                  type="button"
                  onClick={() => setInterval(minutes)}
                  className={optionClass(interval === minutes)}
                  aria-pressed={interval === minutes}
                  data-testid={`reminder-interval-${minutes}`}
                >
                  {intervalLabel(minutes)}
                </button>
              ))}
            </div>
          </div>
        </div>
      </Modal>
    </>
  );
}
