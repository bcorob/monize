'use client';

import { useCallback } from 'react';
import { useTranslations } from 'next-intl';
import { RULE_CONDITION_FIELDS, RULE_WEEKDAYS } from '@/lib/rule-fields';
import type { RuleField } from '@/types/transaction-rule';

export interface RuleEnumLabels {
  /** The translated name of one value of an enum field; the value itself when it is unknown. */
  label: (field: RuleField, value: string) => string;
  /** Every value of an enum field with its name, in the table's order (Monday first for weekdays). */
  options: (field: RuleField) => { value: string; label: string }[];
}

/**
 * The names of the values of the enum fields (`type`, `weekday`, `status`),
 * from the catalogs that already hold them: the transaction types of this
 * namespace, the day names the calendars use (`common.weekdaysShort`, stored
 * Sunday first) and the status names of the transaction filter.
 */
export function useRuleEnumLabels(): RuleEnumLabels {
  const t = useTranslations('rules.editor');
  const tc = useTranslations('common');
  const ts = useTranslations('transactions.filter.statusLabels');

  const label = useCallback(
    (field: RuleField, value: string): string => {
      // A value newer than this client is shown as it is, never as a missing message.
      if (!RULE_CONDITION_FIELDS[field].enumValues?.includes(value)) return value;
      if (field === 'type') return t(`types.${value}`);
      if (field === 'weekday') {
        const at = (RULE_WEEKDAYS as readonly string[]).indexOf(value);
        const names = tc.raw('weekdaysShort') as string[];
        // MON is index 0 here and 1 in the Sunday-first list.
        return at === -1 ? value : (names[(at + 1) % 7] ?? value);
      }
      if (field === 'status') return ts(value.toLowerCase());
      return value;
    },
    [t, tc, ts],
  );

  const options = useCallback(
    (field: RuleField) =>
      (RULE_CONDITION_FIELDS[field].enumValues ?? []).map((value) => ({ value, label: label(field, value) })),
    [label],
  );

  return { label, options };
}
