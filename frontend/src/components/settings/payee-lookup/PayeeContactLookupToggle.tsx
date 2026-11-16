'use client';

import { useState } from 'react';
import toast from 'react-hot-toast';
import { useTranslations } from 'next-intl';
import { ToggleSwitch } from '@/components/ui/ToggleSwitch';
import { userSettingsApi } from '@/lib/user-settings';
import { usePreferencesStore } from '@/store/preferencesStore';
import { getErrorMessage } from '@/lib/errors';

interface PayeeContactLookupToggleProps {
  disabled?: boolean;
  /**
   * Whether a lookup can run at all -- Google Places within its cap, or an AI
   * provider, each switched on.
   *
   * `false` shows the switch OFF and disabled rather than hidden: the sources
   * are configured immediately above it, so disappearing on the last one being
   * switched off reads as a bug, while an inert switch shows exactly what an
   * automatic lookup would now do.
   *
   * `undefined` means NOT KNOWN -- the status request is still in flight, or
   * it failed -- and renders as the ordinary live switch. The copy under
   * `false` names a repair ("switch on a source above"), and naming a repair
   * for a state we have not established sends the user to fix something that
   * may not be broken: on every load of this screen it would flash under a
   * perfectly configured Google Places row.
   */
  lookupAvailable?: boolean;
}

/**
 * Opt-in for the automatic payee contact lookup -- the one that runs by itself
 * when a payee is created with nothing but a name. The buttons on the payee
 * form and detail card are not gated by it: a click is its own consent.
 *
 * Rendered as a block INSIDE the Payee Lookup section rather than as a card of
 * its own: it is one more thing about the same feature, and a second heading
 * for it read as a second feature. It therefore draws no Card and no <h2> --
 * `PayeeLookupSection` owns both.
 *
 * The payee form reads the same `payeeContactLookupEnabled` preference from the
 * store, so the switch takes effect on the next payee immediately (optimistic),
 * reverting on save error.
 */
export function PayeeContactLookupToggle({
  disabled = false,
  lookupAvailable,
}: PayeeContactLookupToggleProps) {
  // Only an established `false` withholds the switch. Deliberately not
  // `!lookupAvailable`, which would read "not known" as "nothing can answer".
  const usable = lookupAvailable !== false;
  const t = useTranslations('settings.payeeLookup.automatic');
  const preferences = usePreferencesStore((s) => s.preferences);
  const updatePreferencesStore = usePreferencesStore((s) => s.updatePreferences);
  const enabled = preferences?.payeeContactLookupEnabled ?? false;
  const [saving, setSaving] = useState(false);

  const handleToggle = async (next: boolean) => {
    if (saving) return;
    setSaving(true);
    updatePreferencesStore({ payeeContactLookupEnabled: next });
    try {
      const updated = await userSettingsApi.updatePreferences({
        payeeContactLookupEnabled: next,
      });
      updatePreferencesStore(updated);
      toast.success(next ? t('enabled') : t('disabled'));
    } catch (error) {
      updatePreferencesStore({ payeeContactLookupEnabled: !next });
      toast.error(getErrorMessage(error, t('saveFailed')));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="mt-6 border-t border-gray-200 pt-4 dark:border-gray-700">
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="text-sm font-medium text-gray-900 dark:text-gray-100">
            {t('title')}
          </p>
          <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
            {usable ? t('subtitle') : t('noSource')}
          </p>
        </div>
        <ToggleSwitch
          // Shown off when nothing can answer -- which is what an automatic
          // lookup would do. The stored preference is deliberately NOT written
          // to false: switching a source back on should restore the setting
          // the user chose, not silently leave it off.
          checked={enabled && usable}
          onChange={handleToggle}
          disabled={disabled || saving || !usable}
          label={t('toggleLabel')}
        />
      </div>
    </div>
  );
}
