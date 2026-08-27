'use client';

import { useEffect, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { customReportsApi } from '@/lib/custom-reports';
import { investmentReportsApi } from '@/lib/investment-reports';
import { usePreferencesStore } from '@/store/preferencesStore';
import { createLogger } from '@/lib/logger';
import {
  builtInReports,
  type ReportCategory,
} from '@/components/reports/report-definitions';

const logger = createLogger('useReportCatalog');

export interface ReportCatalogEntry {
  /**
   * The id the Reports page uses, which is also the route under `/reports/`:
   * `tax-summary`, `custom/<uuid>`, `investment/<uuid>`.
   */
  id: string;
  name: string;
  category: ReportCategory;
  /**
   * Whether the user has starred this report. Built-ins read it from the
   * reactive `favouriteReportIds` preference, so toggling a favourite anywhere
   * reorders the switcher on the next render; a saved report carries its own
   * `isFavourite`.
   */
  isFavourite: boolean;
}

/**
 * Every report the user can open, named and placed in its section: the built-in
 * catalog plus their saved custom and investment reports.
 *
 * Both API calls are served from the five-minute cache the Reports page already
 * fills, so opening a report does not pay for this a second time. A failed load
 * leaves the user's own reports out of the list rather than inventing an empty
 * one -- the switcher is a shortcut, and "Back to Reports" still reaches the
 * complete list -- so nothing here should be read as "the user has none".
 */
export function useReportCatalog(): { reports: readonly ReportCatalogEntry[] } {
  const t = useTranslations('reports');
  const favouriteReportIds = usePreferencesStore(
    (s) => s.preferences?.favouriteReportIds,
  );
  const [customNames, setCustomNames] = useState<
    readonly { id: string; name: string; isFavourite: boolean }[]
  >([]);
  const [investmentNames, setInvestmentNames] = useState<
    readonly { id: string; name: string; isFavourite: boolean }[]
  >([]);

  useEffect(() => {
    let active = true;
    customReportsApi
      .getAll()
      .then((reports) => {
        if (!active) return;
        setCustomNames(
          reports.map((r) => ({
            id: r.id,
            name: r.name,
            isFavourite: r.isFavourite,
          })),
        );
      })
      .catch((error) => logger.error('Failed to load custom reports:', error));
    investmentReportsApi
      .getAll()
      .then((reports) => {
        if (!active) return;
        setInvestmentNames(
          reports.map((r) => ({
            id: r.id,
            name: r.name,
            isFavourite: r.isFavourite,
          })),
        );
      })
      .catch((error) =>
        logger.error('Failed to load investment reports:', error),
      );
    return () => {
      active = false;
    };
  }, []);

  const reports = useMemo<ReportCatalogEntry[]>(
    () => [
      ...builtInReports.map((report) => ({
        id: report.id,
        name: t(`page.names.${report.id}` as Parameters<typeof t>[0]),
        category: report.category,
        isFavourite: (favouriteReportIds ?? []).includes(report.id),
      })),
      ...customNames.map((report) => ({
        id: `custom/${report.id}`,
        name: report.name,
        category: 'custom' as ReportCategory,
        isFavourite: report.isFavourite,
      })),
      ...investmentNames.map((report) => ({
        id: `investment/${report.id}`,
        name: report.name,
        category: 'investment' as ReportCategory,
        isFavourite: report.isFavourite,
      })),
    ],
    [customNames, investmentNames, favouriteReportIds, t],
  );

  return { reports };
}
