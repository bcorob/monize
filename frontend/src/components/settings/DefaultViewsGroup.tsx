'use client';

import { useState } from 'react';
import toast from 'react-hot-toast';
import { useTranslations } from 'next-intl';
import { Select } from '@/components/ui/Select';
import { ToggleSwitch } from '@/components/ui/ToggleSwitch';
import { Button } from '@/components/ui/Button';
import { DefaultColumnsField } from '@/components/settings/DefaultColumnsField';
import { clearBrowserViewChoices } from '@/lib/browser-view-choices';
import {
  BUILT_IN_VIEW_DEFAULTS,
  VIEW_DEFAULT_FIELDS,
  readViewDefaults,
  type AccountOpenTarget,
  type ViewDefaults,
} from '@/lib/view-defaults';
import type { DensityLevel } from '@/hooks/useTableDensity';
import type { HiddenTableColumns } from '@/lib/hidden-columns';
import type { UpdatePreferencesData } from '@/types/auth';

interface DefaultViewsGroupProps {
  /** The stored `viewDefaults` preference, untrusted until read. */
  initial: unknown;
  /** The stored `hiddenTableColumns` preference, the default column sets. */
  initialHiddenColumns?: HiddenTableColumns | null;
  /** PreferencesSection's optimistic write, shared by every control it hosts. */
  commit: (patch: UpdatePreferencesData, revert: () => void) => void;
  className?: string;
}

type FlagKey = 'hideRegisterYear' | 'chartCollapsed' | 'widgetsCollapsed';

const FLAGS: readonly { key: FlagKey; labelKey: string }[] = [
  { key: 'hideRegisterYear', labelKey: 'hideRegisterYearLabel' },
  { key: 'chartCollapsed', labelKey: 'chartCollapsedLabel' },
  { key: 'widgetsCollapsed', labelKey: 'widgetsCollapsedLabel' },
];

/**
 * The "Default views" group of the Preferences card: account-level defaults
 * for the view settings each browser otherwise keeps for itself (the default
 * column sets among them), plus where opening an account goes.
 *
 * The map is one preference, but each control sends only its own key and the
 * server merges it into the stored map, so a save from this screen never
 * erases a default another device set after it opened. For the same reason a
 * failed save puts back only its own key, and only while that key still holds
 * the value it tried to save: a later change in flight is not undone by an
 * earlier one failing.
 */
export function DefaultViewsGroup({
  initial,
  initialHiddenColumns,
  commit,
  className,
}: DefaultViewsGroupProps) {
  const t = useTranslations('settings.preferences');
  const tc = useTranslations('common');
  const [values, setValues] = useState<ViewDefaults>(() => readViewDefaults(initial));
  const effective = { ...BUILT_IN_VIEW_DEFAULTS, ...values };

  const update = <K extends keyof ViewDefaults>(key: K, value: NonNullable<ViewDefaults[K]>) => {
    // Picking what is already shown is not an edit, and must not toast as one.
    if (effective[key] === value) return;
    const previous = values[key];
    setValues((current) => ({ ...current, [key]: value }));
    // A computed generic key types as an index signature; it is one ViewDefaults key.
    commit({ viewDefaults: { [key]: value } as ViewDefaults }, () =>
      setValues((current) => {
        if (current[key] !== value) return current;
        if (previous !== undefined) return { ...current, [key]: previous };
        return Object.fromEntries(
          Object.entries(current).filter(([k]) => k !== key),
        ) as ViewDefaults;
      }),
    );
  };

  const applyHere = () => {
    clearBrowserViewChoices();
    toast.success(t('defaultViews.appliedHere'));
  };

  return (
    <div className={className}>
      <h3 className="text-base font-semibold text-gray-900 dark:text-gray-100 mb-1">
        {t('groups.defaultViews')}
      </h3>
      <p className="text-xs text-gray-500 dark:text-gray-400 mb-3">{t('defaultViews.intro')}</p>
      <div className="space-y-4">
        <Select
          label={t('defaultViews.rowsLabel')}
          options={VIEW_DEFAULT_FIELDS.density.map((level) => ({
            value: level,
            label: tc(`density.${level}`),
          }))}
          value={effective.density}
          onChange={(e) => update('density', e.target.value as DensityLevel)}
        />

        {FLAGS.map(({ key, labelKey }) => (
          <div key={key} className="flex items-center">
            <label className="flex items-center gap-2 cursor-pointer">
              <ToggleSwitch
                checked={effective[key]}
                onChange={(next) => update(key, next)}
                label={t(`defaultViews.${labelKey}`)}
              />
              <span className="text-sm text-gray-900 dark:text-gray-100">
                {t(`defaultViews.${labelKey}`)}
              </span>
            </label>
          </div>
        ))}

        <div>
          <Select
            label={t('defaultViews.accountOpenTargetLabel')}
            options={VIEW_DEFAULT_FIELDS.accountOpenTarget.map((target) => ({
              value: target,
              label: t(`defaultViews.accountOpenTargetOptions.${target}`),
            }))}
            value={effective.accountOpenTarget}
            onChange={(e) => update('accountOpenTarget', e.target.value as AccountOpenTarget)}
          />
          <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
            {t('defaultViews.accountOpenTargetHelp')}
          </p>
        </div>

        <DefaultColumnsField initial={initialHiddenColumns} commit={commit} />

        <div>
          <Button type="button" variant="outline" size="sm" onClick={applyHere}>
            {t('defaultViews.applyHere')}
          </Button>
          <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
            {t('defaultViews.applyHereHelp')}
          </p>
        </div>
      </div>
    </div>
  );
}
