'use client';

import { useTranslations } from 'next-intl';
import { InfoTooltip } from '@/components/ui/InfoTooltip';
import { Input } from '@/components/ui/Input';
import type { ParserFormChange, ParserFormState } from '@/lib/receipt-parser-form';
import { RECEIPT_PARSER_LIMITS } from '@/types/email-receipts';

interface ParserProposalFieldsProps {
  form: ParserFormState;
  onChange: ParserFormChange;
}

const CHECKBOX_CLASS =
  'h-4 w-4 cursor-pointer rounded border-gray-300 text-blue-600 focus-visible:ring-blue-500 dark:border-gray-600';

/**
 * What the profile adds to the proposals it makes: a tag on the transactions it
 * categorises (created when the user has none by that name; the name starts as
 * the profile's own), and whether the AI chooses the category of an item no rule
 * matched. Neither moves money: the card shows both and a person approves it.
 */
export function ParserProposalFields({ form, onChange }: ParserProposalFieldsProps) {
  const t = useTranslations('emailReceipts.editor.proposal');

  return (
    <fieldset className="space-y-4 rounded-lg border border-gray-200 p-3 dark:border-gray-700">
      <legend className="px-1 text-sm font-semibold text-gray-900 dark:text-gray-100">{t('heading')}</legend>

      <div className="space-y-2">
        <label className="flex cursor-pointer items-center gap-2 text-sm text-gray-800 dark:text-gray-200">
          <input
            type="checkbox"
            checked={form.tagEnabled}
            onChange={(e) =>
              onChange((current) => ({
                tagEnabled: e.target.checked,
                // The name a person has not chosen yet is the profile's own.
                ...(e.target.checked && current.tagName.trim() === '' ? { tagName: current.name.trim() } : {}),
              }))
            }
            className={CHECKBOX_CLASS}
          />
          {t('tagLabel')}
          <InfoTooltip text={t('tagHelp')} placement="top" usePortal />
        </label>
        {form.tagEnabled && (
          <Input
            id="parser-tag"
            label={t('tagNameLabel')}
            value={form.tagName}
            maxLength={RECEIPT_PARSER_LIMITS.maxTagLength}
            onChange={(e) => onChange({ tagName: e.target.value })}
          />
        )}
      </div>

      <div>
        <label className="flex cursor-pointer items-center gap-2 text-sm text-gray-800 dark:text-gray-200">
          <input
            type="checkbox"
            checked={form.aiCategories}
            onChange={(e) => onChange({ aiCategories: e.target.checked })}
            className={CHECKBOX_CLASS}
          />
          {t('aiCategoriesLabel')}
          <InfoTooltip text={t('aiCategoriesHelp')} placement="top" usePortal />
        </label>
      </div>
    </fieldset>
  );
}
