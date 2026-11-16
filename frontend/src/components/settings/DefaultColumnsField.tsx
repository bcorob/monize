'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import {
  HIDDEN_COLUMN_TABLES,
  HIDEABLE_COLUMNS,
  hiddenColumnsFor,
  type HiddenColumnTable,
  type HiddenTableColumns,
} from '@/lib/hidden-columns';
import type { UpdatePreferencesData } from '@/types/auth';

interface DefaultColumnsFieldProps {
  /** The stored `hiddenTableColumns` preference, untrusted until read. */
  initial: HiddenTableColumns | null | undefined;
  /** PreferencesSection's optimistic write, shared by every control it hosts. */
  commit: (patch: UpdatePreferencesData, revert: () => void) => void;
}

/** Every table kind's hidden set, unknown kinds and ids dropped. */
function readAll(map: HiddenTableColumns | null | undefined) {
  return Object.fromEntries(
    HIDDEN_COLUMN_TABLES.map((table) => [table, hiddenColumnsFor(map, table)]),
  ) as Record<HiddenColumnTable, string[]>;
}

function sameIds(a: readonly string[], b: readonly string[]) {
  return a.length === b.length && a.every((id, i) => id === b[i]);
}

/**
 * The default column set of each hideable table, in the "Default views" group:
 * the columns a table shows in a browser that has not chosen its own from the
 * table's Columns menu. A tick means shown, as it does in that menu.
 *
 * Each change sends only its own table kind and the server merges it into the
 * stored map, so a save here never erases another kind's default set from
 * another device. A failed save puts back its own kind only while that kind
 * still holds the set it tried to save.
 */
export function DefaultColumnsField({ initial, commit }: DefaultColumnsFieldProps) {
  const t = useTranslations('settings.preferences');
  const tTx = useTranslations('transactions');
  const tInv = useTranslations('investments');
  const [hidden, setHidden] = useState(() => readAll(initial));

  // The labels each table's own header and Columns menu show.
  const labels: { [T in HiddenColumnTable]: Record<(typeof HIDEABLE_COLUMNS)[T][number], string> } = {
    transactions: {
      description: tTx('list.header.description'),
      refNumber: tTx('list.header.refNumber'),
      tags: tTx('list.header.tags'),
      attachments: tTx('list.header.attachments'),
      status: tTx('list.header.status'),
    },
    investmentHoldings: {
      shares: tInv('groupedHoldings.sharesColumn'),
      avgCost: tInv('groupedHoldings.avgCostColumn'),
      price: tInv('groupedHoldings.priceColumn'),
      costBasis: tInv('groupedHoldings.costBasisColumn'),
      mktValue: tInv('groupedHoldings.mktValueColumn'),
      gainLoss: tInv('groupedHoldings.gainLossColumn'),
      portfolioPercent: tInv('groupedHoldings.portfolioPercentColumn'),
    },
    investmentRegister: {
      shares: tInv('transactionList.sharesColumn'),
      price: tInv('transactionList.priceColumn'),
      status: tTx('list.header.status'),
    },
  };

  const toggle = (table: HiddenColumnTable, id: string, shown: boolean) => {
    const previous = hidden[table];
    const wanted = shown ? previous.filter((c) => c !== id) : [...previous, id];
    const next = hiddenColumnsFor({ [table]: wanted }, table) as string[];
    setHidden((current) => ({ ...current, [table]: next }));
    commit({ hiddenTableColumns: { [table]: next } }, () =>
      setHidden((current) =>
        sameIds(current[table], next) ? { ...current, [table]: previous } : current,
      ),
    );
  };

  return (
    <div>
      <p className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
        {t('defaultViews.columnsLabel')}
      </p>
      <p className="text-xs text-gray-500 dark:text-gray-400 mb-2">
        {t('defaultViews.columnsHelp')}
      </p>
      <div className="space-y-3 border-l-2 border-gray-200 dark:border-gray-700 pl-4">
        {HIDDEN_COLUMN_TABLES.map((table) => (
          <fieldset key={table}>
            <legend className="text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400 mb-1">
              {t(`defaultViews.columnTables.${table}`)}
            </legend>
            <div className="flex flex-wrap gap-x-4 gap-y-1">
              {HIDEABLE_COLUMNS[table].map((id) => (
                <label
                  key={id}
                  className="flex items-center gap-2 text-sm text-gray-700 dark:text-gray-300 cursor-pointer"
                >
                  <input
                    type="checkbox"
                    checked={!hidden[table].includes(id)}
                    onChange={(e) => toggle(table, id, e.target.checked)}
                    className="h-4 w-4 rounded border-gray-300 text-blue-600 focus-visible:ring-blue-500 dark:border-gray-600"
                  />
                  {(labels[table] as Record<string, string>)[id]}
                </label>
              ))}
            </div>
          </fieldset>
        ))}
      </div>
    </div>
  );
}
