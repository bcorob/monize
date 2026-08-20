'use client';

import { BrandLogo } from '@/components/ui/BrandLogo';
import { payeeLogoUrl } from '@/lib/payees';

export interface PayeeLogoData {
  id: string;
  name: string;
  hasLogo: boolean;
}

interface PayeeLogoProps {
  payee?: PayeeLogoData | null;
  /**
   * Name for the letter badge when there is no payee record to read one from
   * -- a free-text payee on a transaction has a name but no row, and so no
   * logo route, yet still needs a badge to keep a column aligned.
   */
  name?: string | null;
  /** Rendered square size in pixels. */
  size?: number;
  className?: string;
  /** Glyph shown when there is no name to take an initial from. */
  fallbackGlyph?: string;
  /** Icon shown instead of the glyph when there is no payee at all. */
  fallbackIcon?: React.ReactNode;
}

/**
 * A payee's cached brand favicon, resolved from its website exactly as an
 * institution's is. The rendering and fallback live in `BrandLogo`; this only
 * says which entity's logo route to read.
 */
export function PayeeLogo({
  payee,
  name,
  size = 20,
  className = '',
  fallbackGlyph = '$',
  fallbackIcon,
}: PayeeLogoProps) {
  return (
    <BrandLogo
      src={payee?.hasLogo ? payeeLogoUrl(payee.id) : null}
      name={payee?.name ?? name}
      size={size}
      className={className}
      fallbackGlyph={fallbackGlyph}
      fallbackIcon={fallbackIcon}
    />
  );
}
