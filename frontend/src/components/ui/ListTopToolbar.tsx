'use client';

import { Pagination } from '@/components/ui/Pagination';
import { DensityToggle } from '@/components/ui/DensityToggle';
import type { DensityView } from '@/store/densityStore';

interface ListTopToolbarProps {
  /** Which surface's remembered row density the toggle in this bar reads. */
  densityView: DensityView;
  /**
   * Paging state. Supply all five or none: with them the bar carries the
   * pager and the buttons ride on its right, without them it is the buttons
   * alone.
   *
   * A single page keeps the pager too. Its buttons are inert there, but the
   * line beside them -- "Showing 1-7 of 7 transactions" -- is the answer to
   * "did that filter work?", and hiding it exactly when a filter has narrowed
   * the list to one page takes the count away at the moment it is being read.
   */
  currentPage?: number;
  totalPages?: number;
  totalItems?: number;
  pageSize?: number;
  onPageChange?: (page: number) => void;
  /** Plural noun for "Showing 1-25 of 90 <itemName>" -- always translated. */
  itemName?: string;
  /** Buttons that belong to the list itself (export, and the like). */
  actions?: React.ReactNode;
}

/**
 * The grey strip above a table: where you are in the list on the left, the
 * controls that act on the whole list on the right.
 *
 * It is one component because it is one thing the user learns once. The cash
 * register drew it and the brokerage register did not, so the two halves of an
 * investment account -- one toggle apart, on the same page -- put their pager
 * in different places and their density button in different rows, and the
 * brokerage side's pager was below the table where a reader who had just
 * scrolled a page of trades would not meet it. A second copy of this markup is
 * how that came back, so `ui-conventions.test.ts` fails on one.
 */
export function ListTopToolbar({
  densityView,
  currentPage,
  totalPages,
  totalItems,
  pageSize,
  onPageChange,
  itemName,
  actions,
}: ListTopToolbarProps) {
  const buttons = (
    <div className="flex items-center gap-1 flex-shrink-0">
      {actions}
      <DensityToggle view={densityView} hideLabelOnMobile className="flex-shrink-0" />
    </div>
  );

  const showPagination =
    currentPage !== undefined &&
    totalPages !== undefined &&
    totalItems !== undefined &&
    pageSize !== undefined &&
    onPageChange !== undefined;

  return (
    <div className="flex items-center justify-end p-2 border-b border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800">
      {showPagination ? (
        <div className="flex-1">
          <Pagination
            currentPage={currentPage}
            totalPages={totalPages}
            totalItems={totalItems}
            pageSize={pageSize}
            onPageChange={onPageChange}
            itemName={itemName}
            minimal
            infoRight={buttons}
          />
        </div>
      ) : (
        buttons
      )}
    </div>
  );
}
