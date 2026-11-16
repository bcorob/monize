'use client';

import { useState, useEffect, useCallback, forwardRef, InputHTMLAttributes, FocusEvent } from 'react';
import { cn, inputBaseClasses, inputErrorClasses } from '@/lib/utils';
import { useNumberFormat } from '@/hooks/useNumberFormat';
import { filterNumberTyping, formatNumberForEdit, parseLocaleNumber } from '@/lib/number-parse';
import { roundToDecimals } from '@/lib/format';

interface NumericInputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'onChange' | 'value' | 'type'> {
  label?: string;
  error?: string;
  prefix?: string;
  suffix?: string;
  /** The numeric value (can be undefined for empty) */
  value: number | undefined;
  /** Called when the value changes (after parsing) */
  onChange: (value: number | undefined) => void;
  /** Maximum decimal places allowed (default: 2) */
  decimalPlaces?: number;
  /** Allow negative values (default: false) */
  allowNegative?: boolean;
  /** Minimum value allowed. Clamped while typing and again on blur. */
  min?: number;
  /**
   * Maximum value allowed. Clamped on blur, not while typing: every prefix of
   * a number is smaller than the number, so a ceiling never blocks a keystroke
   * the way a floor does, and clamping mid-word would hand the parent a value
   * for a field the user has not finished typing.
   */
  max?: number;
}

/**
 * Numeric input component that handles:
 * - Filtering non-numeric characters
 * - Configurable decimal places
 * - Formatting on blur
 * - Optional min value validation
 */
export const NumericInput = forwardRef<HTMLInputElement, NumericInputProps>(
  (
    {
      label,
      error,
      prefix,
      suffix,
      value,
      onChange,
      decimalPlaces = 2,
      allowNegative = false,
      min,
      max,
      className,
      id,
      onBlur,
      onFocus,
      ...props
    },
    ref
  ) => {
    // Defensive default: a partial mock (or an older build mid rolling deploy)
    // may not carry the separators; en-US keeps the previous behaviour. Read the
    // primitive fields so `formatValue`/`parseValue` are stable across renders
    // (the object identity from `?? {}` is not).
    const nfSeparators = useNumberFormat().numberSeparators;
    const sepDecimal = nfSeparators?.decimal ?? '.';
    const sepGroup = nfSeparators?.group ?? ',';
    const numberSeparators = {
      decimal: sepDecimal,
      group: sepGroup,
      ...(nfSeparators?.nativeDecimal ? { nativeDecimal: nfSeparators.nativeDecimal } : {}),
      ...(nfSeparators?.nativeGroup ? { nativeGroup: nfSeparators.nativeGroup } : {}),
    };

    // Format value to specified decimal places, in the user's decimal separator
    // (no grouping) so the field round-trips a value they can read. Memoized on
    // the separators so the sync effect below re-runs when the number locale
    // changes -- the same fix CurrencyInput's formatDisplay carries.
    const formatValue = useCallback(
      (val: number | undefined | null, decimals: number): string =>
        formatNumberForEdit(val, decimals, { decimal: sepDecimal, group: sepGroup }),
      [sepDecimal, sepGroup],
    );

    // Local display state - allows free typing
    const [displayValue, setDisplayValue] = useState(() => formatValue(value, decimalPlaces));
    const [isFocused, setIsFocused] = useState(false);

    // Parse input string to number, in the user's number convention.
    function parseValue(input: string): number | undefined {
      const parsed = parseLocaleNumber(input, numberSeparators);
      if (parsed === undefined) {
        return undefined;
      }
      return roundToDecimals(parsed, decimalPlaces);
    }

    // Sync from parent when value changes externally (e.g., form reset), and
    // reformat if the number locale changes (formatValue is keyed on it).
    useEffect(() => {
      if (!isFocused) {
        setDisplayValue(formatValue(value, decimalPlaces));
      }
    }, [value, isFocused, decimalPlaces, formatValue]);

    const inputId = id || `input-${label?.toLowerCase().replace(/\s+/g, '-')}`;

    function clampToRange(val: number): number {
      if (min !== undefined && val < min) return min;
      if (max !== undefined && val > max) return max;
      return val;
    }

    const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
      // Filter to valid characters, keeping both decimal candidates so parse can
      // disambiguate them (parseLocaleNumber's job, not the filter's).
      let filtered = filterNumberTyping(e.target.value, {
        allowNegative,
        separators: numberSeparators,
      });

      // Limit decimal places while typing, measured from the locale decimal
      // separator (the grouping separator, if any, is disambiguated on parse).
      const dec = numberSeparators.decimal;
      const idx = filtered.indexOf(dec);
      if (idx !== -1 && filtered.length - idx - dec.length > decimalPlaces) {
        filtered = filtered.slice(0, idx + dec.length + decimalPlaces);
      }

      setDisplayValue(filtered);

      // Parse and notify parent
      const parsed = parseValue(filtered);

      // Apply min validation if specified
      if (parsed !== undefined && min !== undefined && parsed < min) {
        onChange(min);
      } else {
        onChange(parsed);
      }
    };

    const handleBlur = (e: FocusEvent<HTMLInputElement>) => {
      setIsFocused(false);

      // Format to specified decimal places on blur
      const parsed = parseValue(displayValue);
      if (parsed !== undefined) {
        // Apply min/max validation
        const finalValue = clampToRange(parsed);
        setDisplayValue(formatValue(finalValue, decimalPlaces));
        // Blur re-parses what the field is showing, which for an unedited field
        // is the parent's own value formatted to `decimalPlaces`. Handing that
        // back is not an edit, and a parent whose `onChange` does more than
        // store the number cannot tell the two apart. Same rule as
        // `CurrencyInput.notifyIfChanged`.
        if (finalValue !== value) onChange(finalValue);
      } else if (displayValue.trim() === '') {
        setDisplayValue('');
      } else {
        // Invalid input - reset to last valid value
        setDisplayValue(formatValue(value, decimalPlaces));
      }

      // Call parent's onBlur if provided
      onBlur?.(e);
    };

    const handleFocus = (e: FocusEvent<HTMLInputElement>) => {
      setIsFocused(true);
      onFocus?.(e);
    };

    const hasAdornment = prefix || suffix;

    return (
      <div className="w-full">
        {label && (
          <label
            htmlFor={inputId}
            className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1"
          >
            {label}
          </label>
        )}
        <div className={hasAdornment ? 'relative' : undefined}>
          {prefix && (
            <span className="absolute inset-y-0 left-0 pl-3 flex items-center text-gray-500 dark:text-gray-400 pointer-events-none">
              {prefix}
            </span>
          )}
          <input
            ref={ref}
            id={inputId}
            type="text"
            inputMode="decimal"
            placeholder={formatNumberForEdit(0, decimalPlaces, numberSeparators)}
            value={displayValue}
            onChange={handleChange}
            onBlur={handleBlur}
            onFocus={handleFocus}
            style={{
              ...(prefix ? { paddingLeft: '1.75rem' } : {}),
              ...(suffix ? { paddingRight: '3rem' } : {}),
            }}
            className={cn(
              inputBaseClasses,
              error && inputErrorClasses,
              className
            )}
            {...props}
          />
          {suffix && (
            <span className="absolute inset-y-0 right-0 pr-3 flex items-center text-gray-500 dark:text-gray-400 pointer-events-none">
              {suffix}
            </span>
          )}
        </div>
        {error && (
          <p className="mt-1 text-sm text-red-600 dark:text-red-400">{error}</p>
        )}
      </div>
    );
  }
);

NumericInput.displayName = 'NumericInput';
