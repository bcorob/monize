'use client';

import { useMemo } from 'react';
import { useTranslations } from 'next-intl';
import { Combobox } from '@/components/ui/Combobox';
import type { ReceiptParserOption } from '@/hooks/useReceiptParserLookups';
import type { ParserFormChange, ParserFormState } from '@/lib/receipt-parser-form';

interface ParserCategoryFieldsProps {
  form: ParserFormState;
  categories: readonly ReceiptParserOption[];
  onChange: ParserFormChange;
}

type NamedCategoryField = 'defaultCategory' | 'shippingCategory' | 'feesCategory';

const FIELDS: ReadonlyArray<{ field: NamedCategoryField; label: string; help: string }> = [
  { field: 'defaultCategory', label: 'defaultLabel', help: 'defaultHelp' },
  { field: 'shippingCategory', label: 'shippingLabel', help: 'shippingHelp' },
  { field: 'feesCategory', label: 'feesLabel', help: 'feesHelp' },
];

/**
 * Which category the items, the shipping line and the fees get. A profile names
 * a category, never an id: the field takes the name as the category list shows it
 * (`Parent: Child`) and offers the existing ones as you type. A name that is not
 * in the list is flagged, because the server would refuse it when the profile is
 * saved. Category rules by item name are an advanced option kept in the JSON.
 */
export function ParserCategoryFields({ form, categories, onChange }: ParserCategoryFieldsProps) {
  const t = useTranslations('emailReceipts.editor.categories');
  // The option's value is its name: what the profile stores.
  const options = useMemo(() => categories.map((option) => ({ value: option.label, label: option.label })), [categories]);
  const known = useMemo(() => new Set(categories.map((option) => option.label.toLowerCase())), [categories]);

  return (
    <div className="space-y-4">
      <div>
        <h4 className="text-sm font-semibold text-gray-900 dark:text-gray-100">{t('heading')}</h4>
        <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">{t('help')}</p>
      </div>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        {FIELDS.map(({ field, label, help }) => {
          const name = form[field].trim();
          const unknown = name !== '' && !known.has(name.toLowerCase());
          return (
            <div key={field}>
              <Combobox
                label={t(label)}
                aria-label={t(label)}
                placeholder={t('categoryPlaceholder')}
                options={options}
                value={form[field]}
                // A picked option and a typed name both arrive as the label; clearing arrives as ''.
                onChange={(value, text) => onChange({ [field]: text || value })}
                allowCustomValue
                usePortal
                openOnFocus={false}
              />
              <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">{t(help)}</p>
              {unknown && (
                <p role="note" className="mt-1 text-xs text-amber-700 dark:text-amber-300">
                  {t('unknownCategory', { name })}
                </p>
              )}
            </div>
          );
        })}
      </div>
      <p className="text-xs text-gray-500 dark:text-gray-400">{t('rulesInJson')}</p>
    </div>
  );
}
