'use client';

import { useTranslations } from 'next-intl';
import { DateInput } from '@/components/ui/DateInput';
import { MultiSelect } from '@/components/ui/MultiSelect';
import { NumericInput } from '@/components/ui/NumericInput';
import type { RuleOption } from '@/components/rules/use-rule-options';
import { MAX_RULE_RUN_LIMIT, hasBackwardsRange, type RunFiltersState } from '@/lib/rule-run-filters';

interface RuleRunFilterFieldsProps {
  filters: RunFiltersState;
  accountOptions: readonly RuleOption[];
  onChange: (filters: RunFiltersState) => void;
  disabled?: boolean;
}

/** Which existing transactions a test or a manual run looks at. Shared by the test panel and the run dialog. */
export function RuleRunFilterFields({ filters, accountOptions, onChange, disabled }: RuleRunFilterFieldsProps) {
  const t = useTranslations('rules.run.filters');
  const backwards = hasBackwardsRange(filters);

  return (
    <fieldset disabled={disabled} className="m-0 min-w-0 border-0 p-0">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div className="sm:col-span-2">
          <MultiSelect
            label={t('accounts')}
            options={[...accountOptions]}
            value={filters.accountIds}
            onChange={(accountIds) => onChange({ ...filters, accountIds })}
            placeholder={t('allAccounts')}
            disabled={disabled}
          />
        </div>
        <DateInput
          label={t('startDate')}
          value={filters.startDate}
          onDateChange={(startDate) => onChange({ ...filters, startDate })}
        />
        <DateInput
          label={t('endDate')}
          value={filters.endDate}
          error={backwards ? t('backwards') : undefined}
          onDateChange={(endDate) => onChange({ ...filters, endDate })}
        />
        <NumericInput
          label={t('limit')}
          value={filters.limit}
          decimalPlaces={0}
          min={1}
          max={MAX_RULE_RUN_LIMIT}
          onChange={(limit) => onChange({ ...filters, limit })}
        />
      </div>
      <p className="mt-2 text-xs text-gray-500 dark:text-gray-400">{t('help', { max: MAX_RULE_RUN_LIMIT })}</p>
    </fieldset>
  );
}
