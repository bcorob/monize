/**
 * Scaling a byte count to the unit it should be read in.
 *
 * Only the scaling lives here. The *rendering* belongs to
 * `useNumberFormat().formatBytes`, because a file size is a number a person
 * reads: `1.4 MB` is `1,4 MB` for a Polish reader and `1,4 Mo` for a French one,
 * and both the decimal mark and the unit abbreviation come from the reader's
 * locale. Splitting it this way keeps the arithmetic testable without a locale
 * and keeps exactly one formatter.
 *
 * The units are `Intl.NumberFormat` unit identifiers, so the abbreviation is
 * CLDR's for the reader's locale rather than a string this repo would otherwise
 * have to translate into twenty-two catalogs.
 */
const BYTE_UNITS = ['byte', 'kilobyte', 'megabyte', 'gigabyte'] as const;

export type ByteUnit = (typeof BYTE_UNITS)[number];

export interface ScaledBytes {
  value: number;
  unit: ByteUnit;
  /** Fraction digits this magnitude should be shown to. */
  decimals: number;
}

/**
 * Pick the unit a byte count reads best in, and the precision for it.
 *
 * Whole bytes are *counted*, so they carry no fractional part; everything above
 * is a measurement and carries one. Anything not a finite positive number reads
 * as zero bytes -- a size is never unknown here (the stash and the API both
 * record one), so this is a guard against `NaN` reaching a formatter rather than
 * a claim about missing data.
 */
export function scaleBytes(bytes: number): ScaledBytes {
  let value = Number.isFinite(bytes) && bytes > 0 ? bytes : 0;
  let index = 0;
  while (value >= 1024 && index < BYTE_UNITS.length - 1) {
    value /= 1024;
    index += 1;
  }
  return { value, unit: BYTE_UNITS[index], decimals: index === 0 ? 0 : 1 };
}
