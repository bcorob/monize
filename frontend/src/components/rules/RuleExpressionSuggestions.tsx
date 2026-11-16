'use client';

import { useTranslations } from 'next-intl';
import { HOVER_ROW_ON_CARD } from '@/components/ui/Card';
import type { Suggestion } from '@/lib/rule-cel';

interface RuleExpressionSuggestionsProps {
  /** Ties the list to the box that controls it. */
  id: string;
  items: readonly Suggestion[];
  active: number;
  onChoose: (index: number) => void;
}

/** The id of one option, which the box points at with `aria-activedescendant`. */
export const suggestionId = (listId: string, index: number): string => `${listId}-${index}`;

/**
 * What can be typed at the caret. The options are chosen with the box's own
 * keys (focus stays in the box, as `aria-activedescendant` requires); a press
 * with a mouse chooses without taking focus from it.
 */
export function RuleExpressionSuggestions({ id, items, active, onChoose }: RuleExpressionSuggestionsProps) {
  const t = useTranslations('rules.editor');
  if (items.length === 0) return null;
  return (
    <ul
      id={id}
      role="listbox"
      aria-label={t('expression.suggestions')}
      className="mt-1 max-h-48 overflow-y-auto rounded-md border border-gray-200 bg-white py-1 shadow-sm dark:border-gray-600 dark:bg-gray-800"
    >
      {items.map((item, position) => (
        <li
          key={item.insert}
          id={suggestionId(id, position)}
          role="option"
          aria-selected={position === active}
          // Keys move the highlight through a list that scrolls: keep it in view.
          ref={(element) => {
            if (position === active) element?.scrollIntoView?.({ block: 'nearest' });
          }}
          // Focus stays in the box: a click on an option must not blur it.
          onMouseDown={(event) => {
            event.preventDefault();
            onChoose(position);
          }}
          className={`flex cursor-pointer items-baseline justify-between gap-3 px-3 py-1.5 text-sm ${
            position === active
              ? 'bg-blue-50 text-gray-900 dark:bg-blue-900/30 dark:text-gray-100'
              : `text-gray-800 dark:text-gray-200 ${HOVER_ROW_ON_CARD}`
          }`}
        >
          <span className="font-mono">{item.label}</span>
          {item.hint && <span className="text-xs text-gray-500 dark:text-gray-400">{t(item.hint)}</span>}
        </li>
      ))}
    </ul>
  );
}
