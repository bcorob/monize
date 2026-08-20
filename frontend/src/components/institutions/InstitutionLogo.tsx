'use client';

import { BrandLogo } from '@/components/ui/BrandLogo';
import { institutionLogoUrl } from '@/lib/institutions';

export interface InstitutionLogoData {
  id: string;
  name: string;
  hasLogo: boolean;
}

interface InstitutionLogoProps {
  institution?: InstitutionLogoData | null;
  /** Rendered square size in pixels. */
  size?: number;
  className?: string;
  /** Glyph shown when there is no institution (e.g. cashflow-only accounts). */
  fallbackGlyph?: string;
  /**
   * Icon shown instead of the glyph when there is no institution at all --
   * e.g. the account-type icon, which says more than a generic "$".
   */
  fallbackIcon?: React.ReactNode;
}

/**
 * An institution's cached brand favicon. The rendering, the badge fallback and
 * the load-failure handling are `BrandLogo`'s; this only says which entity's
 * logo route to read.
 */
export function InstitutionLogo({
  institution,
  size = 20,
  className = '',
  fallbackGlyph = '$',
  fallbackIcon,
}: InstitutionLogoProps) {
  return (
    <BrandLogo
      src={institution?.hasLogo ? institutionLogoUrl(institution.id) : null}
      name={institution?.name}
      size={size}
      className={className}
      fallbackGlyph={fallbackGlyph}
      fallbackIcon={fallbackIcon}
    />
  );
}
