'use client';

import { ExclamationTriangleIcon, InformationCircleIcon } from '@heroicons/react/24/outline';
import { useTranslations } from 'next-intl';
import type { BankSyncProfileNote, BankSyncProfileNoteSeverity } from '@/types/bank-sync';

const ITEM_CLASS: Record<BankSyncProfileNoteSeverity, string> = {
  warning:
    'rounded-lg border border-amber-300 bg-amber-50 p-3 text-amber-900 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-200',
  info: 'px-1 text-gray-700 dark:text-gray-300',
};

const ICON_CLASS: Record<BankSyncProfileNoteSeverity, string> = {
  warning: 'text-amber-600 dark:text-amber-400',
  info: 'text-blue-600 dark:text-blue-400',
};

interface BankSyncProfileNotesProps {
  notes: readonly BankSyncProfileNote[];
}

/**
 * What the server knows about how one bank's API behaves and which problems it
 * has, as a list under a heading. The note bodies are the server's text, in the
 * reader's language when the profile has it and in English otherwise (they live
 * in the profile file), so each carries the `lang` it is really in; only the
 * heading and the severity labels are translated here. A warning is a
 * problem the reader may need to act on, so it sits in an amber box, and the
 * severity is also spoken for a screen reader. Renders nothing for no notes.
 */
export function BankSyncProfileNotes({ notes }: BankSyncProfileNotesProps) {
  const t = useTranslations('settings.bankSync.profileNotes');
  if (notes.length === 0) return null;

  return (
    <section>
      <h4 className="mb-2 text-sm font-semibold text-gray-900 dark:text-gray-100">
        {t('title')}
      </h4>
      <ul className="space-y-2">
        {notes.map((note) => {
          const Icon = note.severity === 'warning' ? ExclamationTriangleIcon : InformationCircleIcon;
          return (
            <li
              key={note.id}
              data-severity={note.severity}
              className={`flex items-start gap-2 text-sm ${ITEM_CLASS[note.severity]}`}
            >
              <Icon
                aria-hidden="true"
                className={`mt-0.5 h-4 w-4 shrink-0 ${ICON_CLASS[note.severity]}`}
              />
              <span>
                <span className="sr-only">{t(`severity.${note.severity}`)} </span>
                <span lang={note.lang}>{note.text}</span>
              </span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
