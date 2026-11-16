'use client';

import { TrashIcon } from '@heroicons/react/24/outline';

/**
 * The trash button at the end of a split line. The transaction form's
 * `SplitEditor` and the rule editor's split action both draw it, so a line is
 * removed the same way on both screens.
 */

const REMOVE_CLASS =
  'text-red-600 dark:text-red-400 hover:text-red-800 dark:hover:text-red-300 disabled:opacity-50 disabled:cursor-not-allowed';

interface RemoveSplitLineButtonProps {
  onClick: () => void;
  disabled?: boolean;
  /** The accessible name (`aria-label`), repeated as the hover tooltip. */
  title: string;
}

export function RemoveSplitLineButton({ onClick, disabled, title }: RemoveSplitLineButtonProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={REMOVE_CLASS}
      aria-label={title}
      title={title}
    >
      <TrashIcon className="h-5 w-5" aria-hidden="true" />
    </button>
  );
}
