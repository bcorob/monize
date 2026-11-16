'use client';

import {
  KeyboardEvent,
  RefObject,
  useCallback,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';
import { useTranslations } from 'next-intl';
import { placePopover } from '@/components/ui/InfoTooltip';
import { HOVER_TOOLBAR_BUTTON } from '@/components/ui/Card';
import { useClickOutside } from '@/hooks/useClickOutside';

const POPOVER_WIDTH = 320;

/**
 * The search syntax, one example per line (docs/specs/advanced-search.md,
 * section 4). The example is the literal text a reader types, so it is not
 * translated; the explanation beside it is.
 */
export const SEARCH_SYNTAX_EXAMPLES = [
  { example: 'costco gas', key: 'allWords' },
  { example: '"costco gas"', key: 'phrase' },
  { example: '-refund', key: 'exclude' },
  { example: 'payee:costco', key: 'fieldContains' },
  { example: 'payee:="Costco"', key: 'fieldExact' },
  { example: '#10', key: 'reference' },
  { example: 'ref:10*', key: 'wildcard' },
  { example: 'amount:>100', key: 'amountOver' },
  { example: 'amount:50..100', key: 'amountRange' },
  { example: 'date:2026-03', key: 'datePeriod' },
  { example: 'is:split', key: 'isSplit' },
  { example: 'has:attachment', key: 'hasAttachment' },
  { example: 'has:warranty', key: 'hasWarranty' },
] as const;

interface SearchSyntaxHelpProps {
  /** Writes an example into the search input, through the input's own setter. */
  onExample: (example: string) => void;
  /**
   * The open popover's element, for a parent whose own outside-click handler
   * must treat a press inside this portal as inside (the header's search).
   */
  popoverRef?: RefObject<HTMLDivElement | null>;
}

/**
 * A `?` beside a transaction search input that opens the search syntax, with
 * every example a button that writes it into the input.
 *
 * Not `InfoTooltip`: that is one string of help, and this holds controls. It
 * opens on a click or a tap only, through a viewport-clamped portal placed by
 * the tooltip's own `placePopover` and re-measured on scroll and resize, moves
 * focus to its first example (a portal at the end of the document is never
 * reached by Tab from the trigger), and closes on Escape, on a press outside
 * it (`useClickOutside`), or when an example is chosen.
 */
export function SearchSyntaxHelp({ onExample, popoverRef }: SearchSyntaxHelpProps) {
  const t = useTranslations('transactions');
  const triggerRef = useRef<HTMLButtonElement>(null);
  const ownPopoverRef = useRef<HTMLDivElement>(null);
  const panelRef = popoverRef ?? ownPopoverRef;
  const [open, setOpen] = useState(false);
  const titleId = useId();

  const close = useCallback(() => setOpen(false), []);

  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const anchor = triggerRef.current;
      const panel = panelRef.current;
      if (!anchor || !panel) return;
      const { top, left } = placePopover(
        anchor.getBoundingClientRect(),
        { width: panel.offsetWidth || POPOVER_WIDTH, height: panel.offsetHeight },
        'bottom',
        { width: window.innerWidth, height: window.innerHeight },
      );
      panel.style.top = `${top}px`;
      panel.style.left = `${left}px`;
    };
    place();
    // The panel is portalled to the end of the document, so Tab from the
    // trigger would never reach it: focus moves to the first example, and
    // Escape hands it back to the trigger.
    panelRef.current
      ?.querySelector<HTMLButtonElement>('button')
      ?.focus({ preventScroll: true });
    window.addEventListener('scroll', place, true);
    window.addEventListener('resize', place);
    return () => {
      window.removeEventListener('scroll', place, true);
      window.removeEventListener('resize', place);
    };
  }, [open, panelRef]);

  // A press outside the trigger and the panel closes it, through the same
  // hook the header's search uses for its own outside press.
  useClickOutside([triggerRef, panelRef], close, { enabled: open });

  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key !== 'Escape' || !open) return;
    // Claimed only while open, so a dialog around the input still closes.
    event.stopPropagation();
    close();
    triggerRef.current?.focus();
  };

  const choose = (example: string) => {
    onExample(example);
    close();
  };

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((value) => !value)}
        onKeyDown={onKeyDown}
        aria-label={t('searchSyntax.open')}
        aria-haspopup="dialog"
        aria-expanded={open}
        className={`inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-md text-gray-500 hover:text-gray-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 dark:text-gray-400 dark:hover:text-gray-200 ${HOVER_TOOLBAR_BUTTON}`}
      >
        <svg
          xmlns="http://www.w3.org/2000/svg"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth={1.5}
          className="h-5 w-5"
          aria-hidden="true"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M9.879 7.519c1.171-1.025 3.071-1.025 4.242 0 1.172 1.025 1.172 2.687 0 3.712-.203.179-.43.326-.67.442-.745.361-1.45.999-1.45 1.827v.75M21 12a9 9 0 11-18 0 9 9 0 0118 0zm-9 5.25h.008v.008H12v-.008z"
          />
        </svg>
      </button>
      {open &&
        createPortal(
          <div
            ref={panelRef}
            role="dialog"
            aria-labelledby={titleId}
            onKeyDown={onKeyDown}
            style={{
              position: 'fixed',
              width: POPOVER_WIDTH,
              maxWidth: 'calc(100vw - 16px)',
            }}
            className="z-50 rounded-md border border-gray-200 bg-white shadow-lg dark:border-gray-700 dark:bg-gray-800"
          >
            <div
              id={titleId}
              className="border-b border-gray-200 px-3 py-2 text-xs font-medium uppercase tracking-wide text-gray-500 dark:border-gray-700 dark:text-gray-400"
            >
              {t('searchSyntax.title')}
            </div>
            <ul className="max-h-80 overflow-y-auto py-1">
              {SEARCH_SYNTAX_EXAMPLES.map(({ example, key }) => (
                <li key={key} className="flex items-baseline gap-3 px-3 py-1">
                  <button
                    type="button"
                    onClick={() => choose(example)}
                    className="shrink-0 rounded px-1 font-mono text-sm text-blue-700 hover:bg-blue-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 dark:text-blue-300 dark:hover:bg-blue-900/30"
                  >
                    {example}
                  </button>
                  <span className="text-xs text-gray-600 dark:text-gray-300">
                    {t(`searchSyntax.examples.${key}`)}
                  </span>
                </li>
              ))}
            </ul>
            <p className="border-t border-gray-200 px-3 py-2 text-xs text-gray-500 dark:border-gray-700 dark:text-gray-400">
              {t('searchSyntax.fields')}
            </p>
          </div>,
          document.body,
        )}
    </>
  );
}
