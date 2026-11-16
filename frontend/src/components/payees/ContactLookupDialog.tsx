'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { Modal } from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import {
  CONTACT_LOOKUP_FIELDS,
  type ContactLookupField,
  type Payee,
  type PayeeContactSuggestion,
} from '@/types/payee';
import { formatPhoneForDisplay } from '@/lib/phone-number';

/** One field the dialog offers, already decided against what the payee holds. */
interface ProposedChange {
  field: ContactLookupField;
  /** What the lookup answered. */
  next: string;
  /** What the payee holds today, when it holds anything. */
  current: string | null;
}

interface ContactLookupDialogProps {
  isOpen: boolean;
  payee: Payee;
  /** Best match first. More than one only when the name is genuinely ambiguous. */
  suggestions: PayeeContactSuggestion[];
  saving: boolean;
  onCancel: () => void;
  /** The fields the user ticked, from the candidate they picked. */
  onConfirm: (values: Partial<Record<ContactLookupField, string>>) => void;
}

/**
 * What the lookup found, and nothing saved until the user says so.
 *
 * The lookup itself never writes (INV-PAYEE-001); this dialogue is where a
 * value that would *replace* something stored becomes legitimate, because the
 * user is shown the old value beside the new one and confirms it. So each row
 * says which of the two it is -- an empty field being filled, or a stored
 * value being replaced -- and each row can be unticked on its own: accepting
 * the address is not accepting the phone number.
 *
 * When the name means more than one organisation or branch, the candidates
 * are offered first and picking one re-derives the rows.
 */
export function ContactLookupDialog({
  isOpen,
  payee,
  suggestions,
  saving,
  onCancel,
  onConfirm,
}: ContactLookupDialogProps) {
  const t = useTranslations('payeeDetail');
  const [selectedIndex, setSelectedIndex] = useState(0);
  // Fields the user has unticked, per candidate: switching candidate and
  // switching back must not silently re-tick what they turned off.
  const [excluded, setExcluded] = useState<ReadonlySet<string>>(() => new Set());

  const selected = suggestions[selectedIndex] ?? suggestions[0];
  const changes: ProposedChange[] = selected
    ? CONTACT_LOOKUP_FIELDS.flatMap((field) => {
        const next = selected[field];
        if (!next) return [];
        return [{ field, next, current: payee[field] ?? null }];
      })
    : [];

  /**
   * How a proposed value is SHOWN. A phone is stored as E.164 and read as
   * grouped digits, so the row the user ticks has to carry the readable form --
   * while `confirm` below still sends the stored one, because what is written
   * is not what is displayed.
   */
  const displayValue = (field: ContactLookupField, value: string) =>
    field === 'phone' ? formatPhoneForDisplay(value) : value;

  const keyOf = (change: ProposedChange) => `${selectedIndex}:${change.field}`;
  const accepted = changes.filter((change) => !excluded.has(keyOf(change)));

  const toggle = (change: ProposedChange) => {
    const key = keyOf(change);
    const next = new Set(excluded);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    setExcluded(next);
  };

  const confirm = () => {
    const values: Partial<Record<ContactLookupField, string>> = {};
    for (const change of accepted) values[change.field] = change.next;
    onConfirm(values);
  };

  return (
    <Modal
      isOpen={isOpen}
      onClose={onCancel}
      maxWidth="lg"
      padding="md"
      pushHistory
      title={t('contactLookup.dialogTitle')}
      description={t('contactLookup.dialogSubtitle', { name: payee.name })}
      footer={
        <>
          <Button type="button" variant="outline" onClick={onCancel} disabled={saving}>
            {t('contactLookup.cancel')}
          </Button>
          <Button
            type="button"
            onClick={confirm}
            disabled={saving || accepted.length === 0}
          >
            {t('contactLookup.confirm', { count: accepted.length })}
          </Button>
        </>
      }
    >
      {suggestions.length > 1 && (
        <fieldset className="mb-4">
          <legend className="mb-2 text-sm font-medium text-gray-700 dark:text-gray-300">
            {t('contactLookup.pickMatch', { count: suggestions.length })}
          </legend>
          <div className="space-y-2">
            {suggestions.map((suggestion, index) => (
              <label
                key={suggestion.label ?? index}
                className="flex cursor-pointer items-start gap-2 rounded-md border border-gray-200 p-2 dark:border-gray-700"
              >
                <input
                  type="radio"
                  name="contact-lookup-match"
                  className="mt-1"
                  checked={index === selectedIndex}
                  onChange={() => setSelectedIndex(index)}
                />
                <span className="text-sm">
                  <span className="block font-medium text-gray-900 dark:text-gray-100">
                    {suggestion.label ?? t('contactLookup.unlabelledMatch')}
                  </span>
                  {suggestion.notes && (
                    <span className="block text-gray-500 dark:text-gray-400">
                      {suggestion.notes}
                    </span>
                  )}
                </span>
              </label>
            ))}
          </div>
        </fieldset>
      )}

      <ul className="space-y-3">
        {changes.map((change) => {
          const key = keyOf(change);
          return (
            <li key={key} className="flex items-start gap-2">
              <input
                id={`contact-lookup-${change.field}`}
                type="checkbox"
                className="mt-1"
                checked={!excluded.has(key)}
                onChange={() => toggle(change)}
              />
              <label htmlFor={`contact-lookup-${change.field}`} className="flex-1 text-sm">
                <span className="flex flex-wrap items-center gap-2">
                  <span className="font-medium text-gray-900 dark:text-gray-100">
                    {t(`keyInfo.${change.field}`)}
                  </span>
                  {/* Which of the two this row is, said rather than implied:
                      replacing something the user entered is the case that
                      needs their eyes on it. */}
                  <Badge variant={change.current ? 'amber' : 'blue'}>
                    {change.current
                      ? t('contactLookup.willReplace')
                      : t('contactLookup.willAdd')}
                  </Badge>
                </span>
                {change.current && (
                  <span className="mt-1 block whitespace-pre-line text-gray-500 line-through dark:text-gray-400">
                    {displayValue(change.field, change.current)}
                  </span>
                )}
                <span className="mt-1 block whitespace-pre-line text-gray-900 dark:text-gray-100">
                  {displayValue(change.field, change.next)}
                </span>
              </label>
            </li>
          );
        })}
      </ul>

      {selected?.notes && suggestions.length === 1 && (
        <p className="mt-4 text-sm text-gray-500 dark:text-gray-400">{selected.notes}</p>
      )}
    </Modal>
  );
}
