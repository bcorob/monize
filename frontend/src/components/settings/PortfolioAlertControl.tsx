'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import toast from 'react-hot-toast';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/Button';
import { ToggleSwitch } from '@/components/ui/ToggleSwitch';
import { NumericInput } from '@/components/ui/NumericInput';
import { notificationPreferencesApi } from '@/lib/notification-preferences';
import { getErrorMessage } from '@/lib/errors';
import { createLogger } from '@/lib/logger';
import { TOUR_ANCHORS, tourAnchor } from '@/lib/tours/anchors';

const log = createLogger('PortfolioAlertControl');

const DEFAULT_PERCENT = 5;
/** How long after the last keystroke a threshold edit auto-saves. */
const SAVE_DEBOUNCE_MS = 700;

/**
 * The opt-in daily portfolio-movement threshold
 * (`docs/specs/portfolio-movement-notifications.md`). Off by default; enabling
 * stores a percentage, disabling clears it (and the producer's baseline).
 *
 * Saves on change like the rest of the settings surface (the manual "Save"
 * button was removed with #1310's move to auto-save): the toggle persists
 * immediately, a threshold edit persists once typing settles, and a failed save
 * reverts the control to the value the server last accepted and shows an error.
 * The portfolio threshold lives on its own endpoint (not `user_preferences`), so
 * it cannot use `useSavedPreference`, but it follows the same contract.
 *
 * A failed load is not "off": it disables the control and offers a retry, so an
 * outage is never rendered as the feature being unavailable.
 */
export function PortfolioAlertControl() {
  const t = useTranslations('settings.notifications.portfolioAlert');
  const [enabled, setEnabled] = useState(false);
  const [percent, setPercent] = useState<number | undefined>(DEFAULT_PERCENT);
  const [loadFailed, setLoadFailed] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  // The value the server last accepted, so a failed auto-save can revert to it
  // and an unchanged value never re-saves. `null` means the alert is off.
  const lastSavedRef = useRef<number | null>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // One loader for both the mount effect and the retry button, so the two
  // cannot drift; `isCancelled` drops a response that arrives after unmount.
  // It writes state only in its callbacks; the retry clears the failure itself.
  const load = useCallback((isCancelled: () => boolean = () => false) => {
    notificationPreferencesApi
      .getPortfolioAlert()
      .then(({ movePercent }) => {
        if (isCancelled()) return;
        lastSavedRef.current = movePercent;
        setEnabled(movePercent != null);
        if (movePercent != null) setPercent(movePercent);
        setLoaded(true);
      })
      .catch((error) => {
        if (isCancelled()) return;
        log.error('Could not load portfolio alert setting', error);
        setLoadFailed(true);
        setLoaded(true);
      });
  }, []);

  useEffect(() => {
    let cancelled = false;
    load(() => cancelled);
    return () => {
      cancelled = true;
      if (saveTimer.current) clearTimeout(saveTimer.current);
    };
  }, [load]);

  // Persist a value. Success is silent (this is auto-save); failure surfaces an
  // error and rethrows so the caller can revert the control it changed.
  const persist = useCallback(
    async (next: number | null) => {
      setBusy(true);
      try {
        await notificationPreferencesApi.setPortfolioAlert(next);
        lastSavedRef.current = next;
      } catch (error) {
        log.error('Could not save portfolio alert setting', error);
        toast.error(getErrorMessage(error, t('saveError')));
        throw error;
      } finally {
        setBusy(false);
      }
    },
    [t],
  );

  const handleToggle = (nextEnabled: boolean) => {
    setEnabled(nextEnabled);
    if (saveTimer.current) clearTimeout(saveTimer.current);
    // Enabling stores the current percent; disabling clears it.
    const target = nextEnabled ? (percent ?? DEFAULT_PERCENT) : null;
    void persist(target).catch(() => setEnabled(!nextEnabled)); // revert on failure
  };

  const handlePercentChange = (value: number | undefined) => {
    setPercent(value);
    if (saveTimer.current) clearTimeout(saveTimer.current);
    // An empty or non-positive field is not a value to save; the toggle owns the
    // off state. Only auto-save a real change once typing settles.
    if (!enabled || value == null || value <= 0) return;
    if (value === lastSavedRef.current) return;
    saveTimer.current = setTimeout(() => {
      void persist(value).catch(() => {
        // Revert to what the server last accepted (NumericInput re-syncs on it).
        setPercent(lastSavedRef.current ?? DEFAULT_PERCENT);
      });
    }, SAVE_DEBOUNCE_MS);
  };

  if (!loaded) return null;

  if (loadFailed) {
    return (
      <div className="text-sm text-gray-600 dark:text-gray-300">
        <p>{t('loadError')}</p>
        <Button
          variant="secondary"
          size="sm"
          onClick={() => {
            setLoadFailed(false);
            load();
          }}
          className="mt-2"
        >
          {t('retry')}
        </Button>
      </div>
    );
  }

  return (
    <div {...tourAnchor(TOUR_ANCHORS.notificationPortfolioAlert)}>
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="font-medium text-gray-900 dark:text-gray-100">
            {t('title')}
          </p>
          <p className="text-sm text-gray-500 dark:text-gray-400 mt-0.5">
            {t('description')}
          </p>
        </div>
        <ToggleSwitch
          checked={enabled}
          onChange={handleToggle}
          disabled={busy}
          label={t('enableLabel')}
        />
      </div>
      {enabled && (
        <div className="mt-3">
          <label className="block text-sm text-gray-700 dark:text-gray-300 mb-1">
            {t('thresholdLabel')}
          </label>
          {/*
            Four decimals, matching this field's own column
            (notification_portfolio_state.move_alert_percent NUMERIC(9,4)) and
            the security price-alert control beside it. At two, a stored 0.1250
            was DISPLAYED as 0.13 and then saved at that rounding on the next
            blur, because NumericInput re-emits when rounding moved the value --
            so a control narrower than its column silently edits what it shows.
          */}
          <NumericInput
            value={percent}
            onChange={handlePercentChange}
            suffix="%"
            decimalPlaces={4}
            min={0.1}
            max={100}
            className="w-32"
          />
        </div>
      )}
    </div>
  );
}
