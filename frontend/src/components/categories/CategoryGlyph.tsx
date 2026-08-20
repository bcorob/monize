'use client';

import { getIconComponent } from '@/components/ui/IconPicker';

interface CategoryGlyphProps {
  /** The category's effective icon (its own, or the nearest ancestor's). */
  icon?: string | null;
  /** The category's effective colour, used to tint the icon or fill the dot. */
  color?: string | null;
  /**
   * True when the value shown was inherited rather than set on this category.
   * Rendered at reduced opacity, the same signal the colour dot has always
   * used, so "mine" and "my parent's" stay distinguishable.
   */
  inherited?: boolean;
  /** Rendered square size in pixels. */
  size?: number;
  title?: string;
  className?: string;
}

/**
 * A category's visual marker: its icon when one is set anywhere up the
 * ancestry, otherwise the colour dot. One component because the category
 * list, the detail header and the subcategory table all draw the same thing,
 * and an icon rendered as its *name* -- which is what happens when a surface
 * interpolates `category.icon` into text -- looks like a typo rather than a
 * missing feature.
 */
export function CategoryGlyph({
  icon,
  color,
  inherited = false,
  size = 16,
  title,
  className = '',
}: CategoryGlyphProps) {
  const dimension = { width: size, height: size };
  const opacity = inherited ? 'opacity-50' : '';

  if (icon) {
    return (
      <span
        aria-hidden
        title={title}
        style={{ ...dimension, color: color ?? undefined }}
        className={`shrink-0 inline-flex items-center justify-center [&>svg]:w-full [&>svg]:h-full ${opacity} ${className}`}
      >
        {getIconComponent(icon)}
      </span>
    );
  }

  if (color) {
    return (
      <span
        aria-hidden
        title={title}
        style={{ ...dimension, backgroundColor: color }}
        className={`shrink-0 rounded-full ${opacity} ${className}`}
      />
    );
  }

  return null;
}
