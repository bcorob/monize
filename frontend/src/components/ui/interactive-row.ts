import type { KeyboardEvent } from 'react';

/**
 * The one keyboard-activation contract for a row or header that is clickable
 * without being a `<button>`.
 *
 * A `<tr>` or `<th>` carrying `onClick` and `cursor-pointer` is unreachable
 * without a pointer unless it is also focusable and answers the activation keys
 * (WCAG 2.1.1). Three tables wrote the same `tabIndex` + Enter/Space handler and
 * the same four focus utilities out by hand, and near-copies exist elsewhere --
 * which is how a row ends up focusable but inert, or focusable with no visible
 * ring. Both halves live here so a new clickable row gets them together:
 *
 * ```tsx
 * <tr
 *   role="row"
 *   tabIndex={0}
 *   className={`cursor-pointer ${INTERACTIVE_ROW_FOCUS_CLASS}`}
 *   onClick={open}
 *   onKeyDown={activateOnKey(open)}
 * >
 * ```
 *
 * A row whose click is CONDITIONAL passes both through the same condition, so it
 * is focusable exactly when it is activatable -- a focus stop that does nothing
 * is worse than none:
 *
 * ```tsx
 * tabIndex={item.id ? 0 : undefined}
 * onKeyDown={item.id ? activateOnKey(() => open(item.id)) : undefined}
 * className={item.id ? `cursor-pointer ${INTERACTIVE_ROW_FOCUS_CLASS}` : ''}
 * ```
 *
 * `interactive-row.guard.test.ts` scans for a hand-rolled copy of either half.
 * This is deliberately NOT a component: the tables it serves are hand-laid with
 * colspans, sticky cells and per-report grid placements (the same reason
 * `ui/Table.tsx` is constants rather than a `<Table>` wrapper).
 */

/**
 * The focus ring for a focusable row or header cell: `focus-visible:` so it
 * paints on Tab and not on a mouse click, and inset (`-2px` offset) because an
 * outward ring on a table cell is clipped by the row above it.
 *
 * Byte-identical to the four utilities the three converted call sites spelled
 * out, so moving them here changed no rendering at any width.
 *
 * `outline-offset-[-2px]` now appears nowhere else in the tree, and Tailwind v4
 * emits utilities only for classes it finds in a source file -- so the move is
 * only safe because its automatic source detection covers `.ts` as well as
 * `.tsx`. Checked by compiling `globals.css` through `@tailwindcss/postcss`
 * against this file: `outline-offset: -2px` is in the output under a
 * `:focus-visible` selector. (`lib/scheduled-kind.ts` holds class constants for
 * the same reason.)
 */
export const INTERACTIVE_ROW_FOCUS_CLASS =
  'focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-blue-600 dark:focus-visible:outline-blue-400';

/**
 * An `onKeyDown` that runs `handler` for Enter and Space, and for nothing else.
 *
 * `preventDefault()` before the handler is what keeps Space from scrolling the
 * page under the row it just activated. Every other key is passed through
 * untouched, so Tab still moves and the arrow keys still scroll.
 *
 * The handler is given the event so a caller that needs it can read it; a plain
 * `() => void` is assignable and is what most rows pass.
 */
export function activateOnKey(
  handler: (event: KeyboardEvent<Element>) => void,
): (event: KeyboardEvent<Element>) => void {
  return (event) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    handler(event);
  };
}
