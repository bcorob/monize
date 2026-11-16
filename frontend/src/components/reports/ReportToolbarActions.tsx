'use client';

import { ExportDropdown } from '@/components/ui/ExportDropdown';
import { RefreshPricesButton } from '@/components/reports/RefreshPricesButton';
import { cn } from '@/lib/utils';

interface ReportToolbarActionsBaseProps {
  /**
   * Present only on a report whose figures depend on security prices: it
   * renders the price-refresh button beside the export. Omit it and the export
   * takes the whole row.
   */
  onRefreshComplete?: (lastUpdated?: string) => void | Promise<void>;
  /** Disables the export (an empty report has nothing to export). */
  disabled?: boolean;
  /** Extra classes for the row, for a caller that has to opt out of a default. */
  className?: string;
}

/**
 * The formats, in the three shapes `ExportDropdown` draws: both, PDF alone, or
 * CSV alone (a report whose view is a matrix of figures with nothing to render
 * as a picture). At least one is required -- the row exists to export.
 */
type ReportToolbarActionsProps = ReportToolbarActionsBaseProps &
  (
    | { onExportPdf: () => void; onExportCsv?: () => void }
    | { onExportPdf?: undefined; onExportCsv: () => void }
  );

/**
 * The trailing actions of a report's toolbar: refresh (where the report has
 * one) and export.
 *
 * **On a phone this is a row of its own, below every selector, spanning the
 * card**: one full-width button, or two equal halves when the report also
 * refreshes prices. From `sm` up it is the toolbar's trailing group at the
 * right edge, where it has always been.
 *
 * The layout lives here rather than in each report because every report got it
 * slightly differently and a dozen of them got it wrong: an unwrapped row
 * carried the export off the right of a phone, and the ones that did wrap left
 * it stranded mid-toolbar or hanging against the right edge. The grid is what
 * makes "spanning the row" true for the export as well as the refresh --
 * `ExportDropdown`'s CSV form lays out as an `inline-block` wrapper, which a
 * grid cell stretches and a flex row would not.
 *
 * `sm:self-stretch` with `h-full` on the buttons is the desktop half: on one
 * line with a picker, a button is the height of the picker, not of its own
 * text. A caller whose toolbar line is taller than a field (a labelled field,
 * a legend) passes `sm:self-auto`.
 *
 * Render it as the LAST child of the toolbar's wrapping row, so the phone's
 * wrap puts it under everything else.
 */
export function ReportToolbarActions({
  onRefreshComplete,
  disabled,
  className,
  // The two handlers travel together as one value: destructured apart, the
  // union widens to two optional props and the export no longer type-checks.
  ...formats
}: ReportToolbarActionsProps) {
  const hasRefresh = onRefreshComplete !== undefined;

  return (
    <div
      className={cn(
        'grid w-full gap-2',
        hasRefresh ? 'grid-cols-2' : 'grid-cols-1',
        'sm:ml-auto sm:flex sm:w-auto sm:shrink-0 sm:items-center sm:self-stretch',
        className,
      )}
    >
      {hasRefresh && (
        <RefreshPricesButton
          onRefreshComplete={onRefreshComplete}
          className="h-full w-full sm:w-auto"
        />
      )}
      <ExportDropdown
        {...formats}
        disabled={disabled}
        containerClassName="w-full sm:w-auto"
        className="h-full w-full justify-center whitespace-nowrap sm:w-auto"
      />
    </div>
  );
}
