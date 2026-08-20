'use client';

import { useState } from 'react';

export interface BrandLogoProps {
  /**
   * Same-origin URL for the cached favicon, or null when the entity has none.
   * Null renders the fallback badge without ever issuing a request.
   */
  src: string | null;
  /** Entity name: the image's alt text, and the source of the letter badge. */
  name?: string | null;
  /** Rendered square size in pixels. */
  size?: number;
  className?: string;
  /** Glyph shown when there is no name to take an initial from. */
  fallbackGlyph?: string;
  /** Icon shown instead of the glyph when there is no entity at all. */
  fallbackIcon?: React.ReactNode;
}

/**
 * A cached brand favicon with a neutral badge fallback -- the one component
 * behind `InstitutionLogo` and `PayeeLogo`.
 *
 * The bytes are always served from our own backend, never a third party: the
 * server resolves the site's favicon once and caches it, so rendering a logo
 * cannot leak which institutions or payees a user has to anyone else. A 404
 * (no cached icon yet, or the fetch failed) lands on `onError` and shows the
 * badge, so the two "no image" paths look the same to the reader.
 */
export function BrandLogo({
  src,
  name,
  size = 20,
  className = '',
  fallbackGlyph = '$',
  fallbackIcon,
}: BrandLogoProps) {
  const [errored, setErrored] = useState(false);

  // Reset the error flag when the image changes, using the "info from previous
  // render" pattern (no setState in an effect).
  const [prevSrc, setPrevSrc] = useState(src);
  if (src !== prevSrc) {
    setPrevSrc(src);
    setErrored(false);
  }

  const dimension = { width: size, height: size };
  const letter = name?.trim()?.charAt(0)?.toUpperCase();
  const fallback = letter ?? fallbackIcon ?? fallbackGlyph;

  if (src && !errored) {
    return (
      // Favicons are tiny, dynamic, and served from our own backend; next/image
      // optimization adds no value and cannot follow the onError fallback.
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={src}
        alt={name ?? ''}
        loading="lazy"
        style={dimension}
        onError={() => setErrored(true)}
        // Circular chip with no forced backing: transparent favicons keep their
        // transparency, opaque ones fill the circle.
        className={`shrink-0 rounded-full object-contain ${className}`}
      />
    );
  }

  return (
    <span
      style={dimension}
      aria-hidden="true"
      className={`shrink-0 inline-flex items-center justify-center rounded-full bg-gray-100 dark:bg-gray-700 text-gray-500 dark:text-gray-400 text-xs font-semibold ${className}`}
    >
      {fallback}
    </span>
  );
}
