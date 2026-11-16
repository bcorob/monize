import apiClient from './api';

/**
 * The reminder client and its shared constants, mirroring the backend's
 * `notification-center/notification-reminder.*`. `REMINDER_MIN_INTERVAL_MINUTES`
 * is held equal to the backend constant by
 * `notification-reminders.contract.test.ts`.
 */

/** The floor on a reminder interval (R3). A stored value below it is clamped up. */
export const REMINDER_MIN_INTERVAL_MINUTES = 5;

/**
 * The interval choices the UI offers, in minutes. Each is at or above the floor;
 * the picker never offers a value the server would clamp.
 */
export const REMINDER_INTERVAL_PRESETS: readonly number[] = [
  5, 15, 30, 60, 180, 360, 720, 1440,
];

/** How a reminder re-delivers -- mirrors the backend `ReminderRepeatMode`. */
export type ReminderRepeatMode = 'once' | 'repeat';

export interface NotificationReminder {
  id: string;
  sourceNotificationId: string | null;
  type: string;
  severity: string;
  title: string;
  message: string;
  data?: Record<string, unknown> | null;
  target: string | null;
  repeatMode: ReminderRepeatMode;
  intervalMinutes: number;
  nextFireAt: string;
  lastFiredAt: string | null;
  fireCount: number;
  createdAt: string;
}

export interface CreateReminderInput {
  sourceNotificationId: string;
  repeatMode: ReminderRepeatMode;
  intervalMinutes: number;
}

export const notificationRemindersApi = {
  list: async (): Promise<NotificationReminder[]> => {
    const response = await apiClient.get<NotificationReminder[]>(
      '/notifications/reminders',
    );
    return response.data;
  },

  create: async (input: CreateReminderInput): Promise<NotificationReminder> => {
    const response = await apiClient.post<NotificationReminder>(
      '/notifications/reminders',
      input,
    );
    return response.data;
  },

  stop: async (id: string): Promise<{ stopped: boolean }> => {
    const response = await apiClient.post<{ stopped: boolean }>(
      `/notifications/reminders/${id}/stop`,
    );
    return response.data;
  },
};
