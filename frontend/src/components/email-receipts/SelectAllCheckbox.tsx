'use client';

interface SelectAllCheckboxProps {
  /** Every selectable row is ticked. */
  checked: boolean;
  /** Some, not all, are ticked: the box shows the mixed state. */
  indeterminate: boolean;
  disabled?: boolean;
  /** Accessible name: the header cell holds no visible text. */
  label: string;
  onChange: () => void;
}

/** The checkbox in a table header that ticks (or clears) every selectable row, with the mixed state when only some are ticked. */
export function SelectAllCheckbox({ checked, indeterminate, disabled = false, label, onChange }: SelectAllCheckboxProps) {
  return (
    <input
      type="checkbox"
      checked={checked}
      ref={(el) => {
        if (el) el.indeterminate = indeterminate;
      }}
      disabled={disabled}
      onChange={onChange}
      aria-label={label}
      aria-checked={indeterminate ? 'mixed' : checked}
      className="h-4 w-4 cursor-pointer rounded border-gray-300 text-blue-600 focus-visible:ring-blue-500 disabled:cursor-not-allowed disabled:opacity-50 dark:border-gray-600"
    />
  );
}
