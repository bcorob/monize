import { ReactNode } from 'react';
import { cn } from '@/lib/utils';

interface EmptyStateProps {
  /** Grey glyph above the title; sized h-12 w-12 by the component. */
  icon?: ReactNode;
  /** Already-translated one-line answer to "why is this list empty?". */
  title: string;
  /** Optional second line (what to do about it). */
  description?: ReactNode;
  /** Optional call to action (a Button, a link). */
  action?: ReactNode;
  className?: string;
}

/**
 * The one empty-state layout for a list or panel with nothing to show:
 * centered grey glyph, one-line title, optional description and action.
 * This was the same `text-center py-12` block hand-rolled in fourteen
 * files, each drifting on its own; `ui-conventions.test.ts` keeps the
 * inline copies shrink-only.
 */
export function EmptyState({ icon, title, description, action, className }: EmptyStateProps) {
  return (
    <div className={cn('text-center py-12', className)}>
      {icon && (
        <div
          aria-hidden
          className="mx-auto h-12 w-12 text-gray-400 dark:text-gray-500 [&>svg]:h-12 [&>svg]:w-12"
        >
          {icon}
        </div>
      )}
      <h3
        className={cn(
          'text-sm font-medium text-gray-900 dark:text-gray-100',
          icon && 'mt-2',
        )}
      >
        {title}
      </h3>
      {description && (
        <div className="mt-1 text-sm text-gray-500 dark:text-gray-400">{description}</div>
      )}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}
