'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/Button';
import { Select } from '@/components/ui/Select';
import { investmentsApi } from '@/lib/investments';
import type { BondProgramSummary } from '@/types/bond';
import { programLabel } from './detail/bond-labels';

/** The country name in the reader's language; the bare code where the runtime cannot name it. */
export function bondCountryName(code: string, locale: string): string {
  try {
    return new Intl.DisplayNames([locale], { type: 'region' }).of(code) ?? code;
  } catch {
    return code;
  }
}

export interface BondProgramPicker {
  options: Array<{ value: string; label: string }>;
  /** The options narrowed to one issuer country (null: every program). */
  optionsFor: (countryCode: string | null) => Array<{ value: string; label: string }>;
  /** The loaded catalog; empty until it has loaded. */
  programs: BondProgramSummary[];
  /** The link that is submitted and shown ('' is "not linked"). */
  effectiveProgramId: string;
  /** The program the effective link names, once the catalog has loaded. */
  program: BondProgramSummary | null;
  /** True while the catalog request is outstanding. */
  isLoading: boolean;
  /** True when the catalog request failed; that is not an empty catalog. */
  loadFailed: boolean;
  retry: () => void;
  /**
   * The linked program's currency when the form's currency no longer matches
   * it. The link is kept (never silently dropped) and the form refuses to save
   * until the reader sets the currency back or unlinks on purpose.
   */
  mismatchedLinkCurrency: string | null;
  /** The loaded catalog has no program at all. */
  catalogEmpty: boolean;
}

/**
 * The catalog's programs, fetched the first time the type is BOND, and the
 * link derived from them.
 *
 * Choosing a program fills the currency (the caller does that), so every
 * program is offered whatever the form's currency says. A stored or chosen link
 * whose currency the form later leaves is never dropped (that would delete the
 * engine's prices unannounced): it stays selected and is reported as
 * `mismatchedLinkCurrency`. With no catalog loaded nothing can be judged, so
 * the stored link stands and stays visible.
 */
export function useBondProgramPicker(
  isBond: boolean,
  currency: string,
  selectedProgramId: string,
): BondProgramPicker {
  const t = useTranslations('securities');
  const tDetail = useTranslations('securityDetail');
  // Null is "not loaded (yet, or the request failed)", never an empty catalog.
  const [programs, setPrograms] = useState<BondProgramSummary[] | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!isBond) return;
    let cancelled = false;
    investmentsApi
      .listBondPrograms()
      .then((list) => {
        if (cancelled) return;
        setPrograms(list);
        setLoadFailed(false);
      })
      .catch(() => {
        if (!cancelled) setLoadFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [isBond, attempt]);

  const optionsFor = useCallback(
    (countryCode: string | null) => {
      const sorted = [...(programs ?? [])]
        .filter((p) => countryCode === null || p.issuerCountryCode === countryCode)
        .sort((a, b) => a.programCode.localeCompare(b.programCode));
      const all = [
        { value: '', label: t('form.bondProgramNone') },
        ...sorted.map((p) => ({ value: p.id, label: programLabel(tDetail, p.programCode) })),
      ];
      // The catalog has not loaded: keep the existing link visible rather than
      // letting the select blank it.
      if (programs === null && selectedProgramId) {
        all.push({ value: selectedProgramId, label: t('form.bondProgramCurrent') });
      }
      return all;
    },
    [programs, selectedProgramId, t, tDetail],
  );
  const options = useMemo(() => optionsFor(null), [optionsFor]);

  const program =
    programs === null || !selectedProgramId
      ? null
      : (programs.find((p) => p.id === selectedProgramId) ?? null);
  const effectiveProgramId =
    selectedProgramId && (programs === null || program !== null) ? selectedProgramId : '';

  return {
    options,
    optionsFor,
    programs: programs ?? [],
    effectiveProgramId,
    program,
    mismatchedLinkCurrency:
      program !== null && program.currency !== currency ? program.currency : null,
    catalogEmpty: programs !== null && programs.length === 0,
    isLoading: isBond && programs === null && !loadFailed,
    loadFailed,
    retry: () => {
      setLoadFailed(false);
      setAttempt((n) => n + 1);
    },
  };
}

interface BondProgramSelectProps {
  picker: BondProgramPicker;
  /** The id of the program the reader chose; '' is "not linked". */
  onChange: (programId: string) => void;
  /** Offer only the programs of this issuer country. */
  countryCode?: string;
  error?: string;
}

/** The bond program select, with a loading hint and a retryable failure. */
export function BondProgramSelect({ picker, onChange, countryCode, error }: BondProgramSelectProps) {
  const t = useTranslations('securities');

  return (
    <div>
      <Select
        label={t('form.bondProgramLabel')}
        options={picker.optionsFor(countryCode ?? null)}
        value={picker.effectiveProgramId}
        onChange={(e) => onChange(e.target.value)}
        error={error}
      />
      {picker.isLoading && (
        <p className="mt-1 text-sm text-gray-500 dark:text-gray-400" role="status">
          {t('form.bondProgramLoading')}
        </p>
      )}
      {picker.mismatchedLinkCurrency !== null && (
        <p role="alert" className="mt-1 text-sm text-red-600 dark:text-red-400">
          {t('form.bondCurrencyLocked', {
            linkedCurrency: picker.mismatchedLinkCurrency,
          })}
        </p>
      )}
      {picker.catalogEmpty && (
        <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
          {t('form.bondNoPrograms')}
        </p>
      )}
      {picker.loadFailed && (
        <div role="alert" className="mt-1 flex flex-wrap items-center gap-2">
          <p className="text-sm text-red-600 dark:text-red-400">
            {t('form.bondProgramLoadFailed')}
          </p>
          <Button type="button" variant="outline" size="sm" onClick={picker.retry}>
            {t('form.bondProgramRetry')}
          </Button>
        </div>
      )}
    </div>
  );
}
