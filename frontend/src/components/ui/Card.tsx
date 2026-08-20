import { createElement, type ElementType, type ReactNode } from 'react';
import { cn } from '@/lib/utils';

/**
 * The one card surface. Every white-on-gray panel in the app -- dashboard
 * widgets, list shells, settings sections, summary tiles -- is this class:
 * the background/radius/shadow trio that used to be inlined hundreds of
 * times, plus the border that GemPrimitives proved out (without it, cards
 * on a matching background read as faint smudges on several of the colour
 * themes, and in dark mode the weakest shadow disappears entirely).
 *
 * Everything here stays on the gray ramp so all colour themes in
 * `themes.css` re-skin it by overriding `--color-gray-*` / `--color-white`;
 * never add a literal hex or an off-ramp hue.
 *
 * Use the `Card` component where a plain wrapper works; use `CARD_CLASS`
 * where the element already exists (a `<table>` shell with `overflow-hidden`,
 * a `<section>` with its own props). `ui-conventions.test.ts` keeps the old
 * inline string shrink-only.
 */
export const CARD_CLASS =
  'bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 ' +
  'border border-gray-200 dark:border-gray-700';

const CARD_PADDING = {
  none: '',
  sm: 'p-3 sm:p-4',
  md: 'p-4 sm:p-6',
} as const;

export type CardPadding = keyof typeof CARD_PADDING;

interface CardProps {
  /** Element to render as; a semantic `<section>` needs its own aria-label. */
  as?: ElementType;
  padding?: CardPadding;
  className?: string;
  children?: ReactNode;
  [key: string]: unknown;
}

export function Card({
  as = 'div',
  padding = 'none',
  className,
  children,
  ...rest
}: CardProps) {
  return createElement(
    as,
    { className: cn(CARD_CLASS, CARD_PADDING[padding], className), ...rest },
    children,
  );
}
