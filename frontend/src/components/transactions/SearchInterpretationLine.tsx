'use client';

import { useTranslations } from 'next-intl';
import { useNumberFormat } from '@/hooks/useNumberFormat';
import { useDateFormat } from '@/hooks/useDateFormat';
import { SearchInterpretation, SearchTermEcho } from '@/types/transaction';

interface SearchInterpretationLineProps {
  /** The register response's `searchInterpretation`; nothing renders without it. */
  interpretation: SearchInterpretation | undefined;
}

const ENUM_FIELDS = new Set(['is', 'has']);

/** Decimals to show for an echoed amount: its own, between two and four. */
function amountDecimals(value: string): number {
  const fraction = value.split('.')[1] ?? '';
  return Math.min(4, Math.max(2, fraction.length));
}

/**
 * How the server read the search string, one phrase per term, under the
 * search box: "Reference is 10", "not Category contains transfer". A term the
 * server could not use as written is struck through with the reason, so a
 * typo in a qualifier is visible instead of silently matching nothing. The
 * server parses; this only displays (advanced-search plan, decision 7).
 */
export function SearchInterpretationLine({ interpretation }: SearchInterpretationLineProps) {
  const t = useTranslations('transactions');
  const { formatNumber } = useNumberFormat();
  const { formatDate } = useDateFormat();

  if (!interpretation || interpretation.terms.length === 0) return null;

  const shownValue = (term: SearchTermEcho, value: string) => {
    // As many decimals as the value carries (money is stored to four), and
    // never fewer than two, so the line never rounds what the server matches.
    if (term.field === 'amount') return formatNumber(Number(value), amountDecimals(value));
    if (term.field === 'date') return formatDate(value);
    return value;
  };

  const describe = (term: SearchTermEcho): string => {
    if (term.field === 'any') {
      return t('searchInterpretation.any', { value: shownValue(term, term.value) });
    }
    if (term.field === 'status') {
      return t('searchInterpretation.status', {
        value: t(`filter.statusLabels.${term.value}`),
      });
    }
    if (ENUM_FIELDS.has(term.field)) {
      return t(`searchInterpretation.enum.${term.field}.${term.value}`);
    }
    return t(`searchInterpretation.ops.${term.op}`, {
      field: t(`searchInterpretation.fields.${term.field}`),
      value: shownValue(term, term.value),
      valueTo: term.valueTo ? shownValue(term, term.valueTo) : '',
    });
  };

  const phrase = (term: SearchTermEcho): string => {
    if (term.ignored === 'malformed') {
      return t('searchInterpretation.malformed', { raw: term.raw });
    }
    if (term.ignored === 'empty') {
      return t('searchInterpretation.empty', { raw: term.raw });
    }
    const body = describe(term);
    return term.negated ? t('searchInterpretation.negated', { phrase: body }) : body;
  };

  return (
    <div
      aria-live="polite"
      className="mt-1 flex flex-wrap items-baseline gap-x-2 text-xs text-gray-600 dark:text-gray-300"
    >
      <span className="font-medium">{t('searchInterpretation.label')}</span>
      <ul className="flex flex-wrap gap-x-3 gap-y-0.5" aria-label={t('searchInterpretation.label')}>
        {interpretation.terms.map((term, index) => (
          <li
            key={`${index}-${term.raw}`}
            className={term.ignored ? 'text-gray-400 line-through dark:text-gray-500' : undefined}
          >
            {phrase(term)}
          </li>
        ))}
      </ul>
    </div>
  );
}
