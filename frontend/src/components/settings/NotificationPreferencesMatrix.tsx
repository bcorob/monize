'use client';

import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import toast from 'react-hot-toast';
import { InfoTooltip } from '@/components/ui/InfoTooltip';
import { ToggleSwitch } from '@/components/ui/ToggleSwitch';
import { EnableThisEndpointButton } from './EnableThisEndpointButton';
import {
  notificationPreferencesApi,
  NOTIFICATION_CATEGORY_CHANNELS,
  THROTTLE_OPTION_MINUTES,
  type NotificationChannelPreference,
  type NotificationPreferencePatch,
} from '@/lib/notification-preferences';
import { currentDeviceFingerprint, pushApi, type PushDevice } from '@/lib/push';
import type { NotificationCategory } from '@/types/notification';
import { createLogger } from '@/lib/logger';
import { subscribePushDevices } from '@/lib/pushDevicesSignal';
import { TOUR_ANCHORS, tourAnchor } from '@/lib/tours/anchors';

const logger = createLogger('NotificationPreferencesMatrix');

interface NotificationPreferencesMatrixProps {
  /**
   * Whether the email channel can deliver: SMTP is configured AND the master
   * email switch is on. The two email columns self-gate on it -- a per-category
   * email choice cannot widen a channel the master switch has closed.
   */
  emailAvailable: boolean;
}

/**
 * The per-category channel matrix. Email has two modes (the REPORT digest and
 * the immediate ALERT), push is the browser channel, UnifiedPush the
 * distributor one, and the cooldown gates the interrupting channels (alert
 * email + push + UnifiedPush).
 *
 * In-app is deliberately NOT a column: the bell shows every notification and
 * there is nothing to choose, so a column of permanent ticks spent a sixth of a
 * phone's width saying so.
 *
 * It renders independent of the email master switch on purpose: push is a
 * separate channel (delivery isolation, discussion #1291), so nesting the whole
 * matrix inside the email-on block would hide push preferences whenever email is
 * off or unconfigured. Each column instead self-gates -- the email columns on
 * `emailAvailable`, the push column on there being a live device (a matrix cell
 * cannot grant the push permission, spec section 14.5), which is why the action
 * that CAN grant it sits underneath. See `docs/specs/notification-preferences.md`.
 *
 * ## Layout
 *
 * One DOM at every width, never two. Below `md` each category is a card of
 * labelled control rows; from `md` up the row wrapper becomes `contents` and its
 * cells fall into the grid as a table-like matrix, exactly the way
 * `PushDiagnostics` reflows its readout. A second copy of the controls behind
 * `md:hidden` would double every `role="switch"` in the accessibility tree and
 * give each one two labelled instances.
 *
 * `md` and not `sm` because `InfoTooltip` is itself desktop-only (a hover
 * popover has no touch trigger): the per-column help has to be inline prose
 * wherever the tooltip is not rendered, so the two breakpoints have to be the
 * same one.
 */
export function NotificationPreferencesMatrix({
  emailAvailable,
}: NotificationPreferencesMatrixProps) {
  const t = useTranslations('settings.notifications.preferences');
  const [rows, setRows] = useState<NotificationChannelPreference[] | null>(null);
  // One slot per category, not one slot: two rows saving at once must not
  // re-enable each other's toggles mid-flight, and a later failure must revert
  // against the snapshot of ITS row, not one a sibling's finally() released.
  const [savingCategories, setSavingCategories] = useState<
    ReadonlySet<NotificationCategory>
  >(new Set());
  const [devices, setDevices] = useState<PushDevice[]>([]);
  const [thisDevice, setThisDevice] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    notificationPreferencesApi
      .list()
      .then((list) => {
        if (!cancelled) setRows(list);
      })
      .catch((error) => {
        // A matrix that will not load is not worth an error state; it simply
        // does not appear, which is where the product was before it existed.
        logger.debug('Could not load notification preferences', error);
        if (!cancelled) setRows([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // The writes live in the inner `run`, so they happen after the request, not during the effect.
  const refreshDevices = useCallback(() => {
    const run = async () => {
      const [rowsFromServer, fingerprint] = await Promise.all([
        pushApi.listDevices(),
        currentDeviceFingerprint().catch(() => null),
      ]);
      setDevices(rowsFromServer);
      setThisDevice(fingerprint);
    };
    return run();
  }, []);

  useEffect(() => {
    // No device information means no push column, not an error: absent or a
    // failed lookup reads as "no device", erring toward disabling a toggle that
    // could never deliver.
    void refreshDevices().catch((error) =>
      logger.debug('Could not load push devices', error),
    );
  }, [refreshDevices]);

  // A device registered or removed by the panel below moves what these columns
  // may offer, and this component's copy of the list is its own.
  useEffect(
    () =>
      subscribePushDevices(() => {
        void refreshDevices().catch((error) =>
          logger.debug('Could not reload push devices', error),
        );
      }),
    [refreshDevices],
  );

  // Optimistic: reflect the choice immediately, revert the whole row if the
  // save fails. One helper for every channel and the cooldown alike.
  const applyPatch = useCallback(
    (
      category: NotificationCategory,
      patch: NotificationPreferencePatch,
      previous: NotificationChannelPreference,
    ) => {
      setSavingCategories((prev) => new Set([...prev, category]));
      setRows(
        (prev) =>
          prev?.map((r) =>
            r.category === category ? { ...r, ...patch } : r,
          ) ?? prev,
      );
      void (async () => {
        try {
          await notificationPreferencesApi.update(category, patch);
        } catch (error) {
          logger.error('Failed to save notification preference', error);
          setRows(
            (prev) =>
              prev?.map((r) => (r.category === category ? previous : r)) ?? prev,
          );
          toast.error(t('saveFailed'));
        } finally {
          setSavingCategories((prev) => {
            const next = new Set(prev);
            next.delete(category);
            return next;
          });
        }
      })();
    },
    [t],
  );

  if (rows === null || rows.length === 0) return null;

  // A live device on a wire is what makes that wire's column a real control.
  // Counted per transport, because push (web push) and unifiedpush are gated
  // independently: a browser with a web-push device but no UnifiedPush endpoint
  // can toggle push, not unifiedpush. A device from before the transport field
  // reads as web push, today's only browser wire -- never as UnifiedPush, so an
  // old row cannot light a column whose endpoint does not exist.
  // A held device (its account signed out of that browser) counts: it resumes
  // when the account signs in there again, so the preference still matters.
  const live = devices.filter((device) => device.disabledAt === null);
  const pushAvailable = live.some(
    (device) => (device.transport ?? 'webpush') === 'webpush',
  );
  const unifiedPushAvailable = live.some(
    (device) => device.transport === 'unifiedpush',
  );
  // Whether the server holds a live row for the endpoint THIS browser is
  // holding. Distinct from `pushAvailable`: a reader whose phone is registered
  // has a working channel and still nothing on the machine in front of them.
  const registeredHere =
    thisDevice !== null &&
    live.some((device) => device.endpointFingerprint === thisDevice);

  return (
    <div
      {...tourAnchor(TOUR_ANCHORS.notificationChannelMatrix)}
      className="border-t border-gray-200 pt-4 pb-4 dark:border-gray-700"
    >
      <h3 className="mb-1 text-sm font-semibold text-gray-900 dark:text-gray-100">
        {t('heading')}
      </h3>
      <p className="mb-3 text-sm text-gray-500 dark:text-gray-400">
        {t('description')}
      </p>

      <div className="grid grid-cols-1 gap-y-3 md:grid-cols-[minmax(0,1fr)_repeat(5,minmax(0,max-content))] md:gap-x-4 md:gap-y-0">
        <ColumnHeader label={t('categoryHeader')} align="left" />
        <ColumnHeader label={t('channels.emailReport')} />
        <ColumnHeader label={t('channels.emailNotification')} />
        <ColumnHeader label={t('channels.push')} />
        <ColumnHeader
          label={t('channels.unifiedpush')}
          hint={t('channels.unifiedpushHint')}
        />
        <ColumnHeader label={t('throttle.label')} hint={t('throttle.hint')} />

        {rows.map((row) => {
          const categoryLabel = t(`categories.${row.category}`);
          const saving = savingCategories.has(row.category);
          // Which channels this category exposes as live controls -- from the
          // server (supportedChannels); the static map only shadows a row on
          // a response from a backend that predates the field.
          const support =
            row.supportedChannels ??
            NOTIFICATION_CATEGORY_CHANNELS[row.category];
          // The cooldown gates the interrupting channels, so it is only
          // meaningful once a SUPPORTED interrupting channel is on for the row.
          const interrupting =
            (support.emailNotification && row.emailNotification) ||
            (support.push && row.push) ||
            (support.unifiedpush && row.unifiedpush);
          return (
            <div
              key={row.category}
              className="rounded-lg border border-gray-200 p-3 md:contents dark:border-gray-700"
            >
              <div className="mb-1 text-sm font-medium text-gray-900 md:mb-0 md:flex md:items-center md:border-t md:border-gray-100 md:py-2 md:font-normal md:text-gray-700 dark:text-gray-100 md:dark:border-gray-800 md:dark:text-gray-300">
                {categoryLabel}
              </div>

              <MatrixCell label={t('channels.emailReport')}>
                {support.email ? (
                  <ToggleSwitch
                    checked={row.email}
                    disabled={saving || !emailAvailable}
                    onChange={() =>
                      applyPatch(row.category, { email: !row.email }, row)
                    }
                    label={t('emailToggleLabel', { category: categoryLabel })}
                    size="sm"
                  />
                ) : (
                  <NotApplicable label={t('channelNotApplicable')} />
                )}
              </MatrixCell>

              <MatrixCell label={t('channels.emailNotification')}>
                {support.emailNotification ? (
                  <ToggleSwitch
                    checked={row.emailNotification}
                    disabled={saving || !emailAvailable}
                    onChange={() =>
                      applyPatch(
                        row.category,
                        { emailNotification: !row.emailNotification },
                        row,
                      )
                    }
                    label={t('emailNotificationToggleLabel', {
                      category: categoryLabel,
                    })}
                    size="sm"
                  />
                ) : (
                  <NotApplicable label={t('channelNotApplicable')} />
                )}
              </MatrixCell>

              <MatrixCell label={t('channels.push')}>
                {support.push ? (
                  <ToggleSwitch
                    checked={row.push}
                    disabled={saving || !pushAvailable}
                    onChange={() =>
                      applyPatch(row.category, { push: !row.push }, row)
                    }
                    label={t('pushToggleLabel', { category: categoryLabel })}
                    size="sm"
                  />
                ) : (
                  <NotApplicable label={t('channelNotApplicable')} />
                )}
              </MatrixCell>

              <MatrixCell label={t('channels.unifiedpush')}>
                {support.unifiedpush ? (
                  <ToggleSwitch
                    checked={row.unifiedpush}
                    disabled={saving || !unifiedPushAvailable}
                    onChange={() =>
                      applyPatch(
                        row.category,
                        { unifiedpush: !row.unifiedpush },
                        row,
                      )
                    }
                    label={t('unifiedpushToggleLabel', {
                      category: categoryLabel,
                    })}
                    size="sm"
                  />
                ) : (
                  <NotApplicable label={t('channelNotApplicable')} />
                )}
              </MatrixCell>

              <MatrixCell label={t('throttle.label')}>
                <select
                  value={String(row.throttleMinutes)}
                  disabled={saving || !interrupting}
                  onChange={(event) =>
                    applyPatch(
                      row.category,
                      { throttleMinutes: Number(event.target.value) },
                      row,
                    )
                  }
                  aria-label={t('throttle.ariaLabel', {
                    category: categoryLabel,
                  })}
                  // `min-w-0` and a phone-only cap, together. A `<select>`
                  // sizes itself to its WIDEST OPTION and its automatic minimum
                  // size is that width, so as a flex item it takes what it wants
                  // and every bit of shrinking falls on the label beside it --
                  // which, being `min-w-0`, collapses to nothing and lets
                  // "Cooldown" overflow underneath the control. Capped and
                  // shrinkable, the two share the row; the selected option
                  // ellipsizes in a locale whose labels are long, which is the
                  // right thing to give up. Neither applies from `md` up, where
                  // the column header carries the label and the cell is its own
                  // grid track.
                  className="min-w-0 max-w-[9.5rem] rounded-md border border-gray-300 bg-white px-2 py-1 text-sm text-gray-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 disabled:opacity-50 md:max-w-none md:text-xs dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100"
                >
                  {THROTTLE_OPTION_MINUTES.map((minutes) => (
                    <option key={minutes} value={minutes}>
                      {t(`throttle.options.${minutes}`)}
                    </option>
                  ))}
                </select>
              </MatrixCell>
            </div>
          );
        })}
      </div>

      {/* `InfoTooltip` renders nothing below `md` -- a hover popover has no touch
          trigger -- so the two column explanations become footnotes there.
          ONCE each, not once per row: the same sentence repeated under every
          category is what a phone has least room for. */}
      <ul className="mt-3 space-y-1 text-xs text-gray-400 md:hidden dark:text-gray-500">
        <li>
          <span className="font-medium text-gray-500 dark:text-gray-400">
            {t('throttle.label')}
          </span>{' '}
          {t('throttle.hint')}
        </li>
        <li>
          <span className="font-medium text-gray-500 dark:text-gray-400">
            {t('channels.unifiedpush')}
          </span>{' '}
          {t('channels.unifiedpushHint')}
        </li>
      </ul>

      <div className="mt-3 space-y-2 text-xs text-gray-400 dark:text-gray-500">
        {!emailAvailable && <p>{t('emailUnavailable')}</p>}
        {!pushAvailable && <p>{t('pushUnavailable')}</p>}
        {/* The one action on this surface that can turn the push column into a
            real control for the machine the reader is sitting at. It renders
            itself away -- hint and all -- when it could not help. */}
        <EnableThisEndpointButton
          registeredHere={registeredHere}
          hint={t('pushEnableHint')}
        />
      </div>
    </div>
  );
}

/**
 * A column heading, and the help that belongs to that column rather than to a
 * footnote under the grid.
 *
 * The heading exists only from `md` up, where the grid has column headings at
 * all. Below that the same sentence is a footnote under the grid, once, rather
 * than repeated inside each of that column's cells.
 */
function ColumnHeader({
  label,
  hint,
  align = 'center',
}: {
  label: string;
  hint?: string;
  align?: 'left' | 'center';
}) {
  return (
    <div
      className={`hidden pb-2 text-xs font-medium text-gray-500 md:flex md:items-center dark:text-gray-400 ${
        align === 'left' ? 'md:justify-start' : 'md:justify-center'
      }`}
    >
      <span>{label}</span>
      {hint && <InfoTooltip text={hint} usePortal />}
    </div>
  );
}

/**
 * One control in the matrix: a labelled row on a phone, a bare centred cell in
 * the grid from `md` up, where the column heading carries the label instead.
 */
function MatrixCell({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-3 py-1 md:justify-center md:border-t md:border-gray-100 md:py-2 md:dark:border-gray-800">
      <span className="min-w-0 flex-1 text-sm text-gray-600 md:hidden dark:text-gray-400">
        {label}
      </span>
      {children}
    </div>
  );
}

/**
 * A cell for a channel this category does not expose as a control. The dash is
 * decorative; the meaning is carried by the localized label for assistive tech.
 */
function NotApplicable({ label }: { label: string }) {
  return (
    <span
      className="inline-flex items-center justify-center text-gray-300 dark:text-gray-600"
      title={label}
    >
      <span aria-hidden="true">&mdash;</span>
      <span className="sr-only">{label}</span>
    </span>
  );
}
