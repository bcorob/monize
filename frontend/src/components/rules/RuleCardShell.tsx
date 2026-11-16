'use client';

import type { ReactNode } from 'react';
import { RowActions } from '@/components/ui/row-actions/RowActions';
import type { RowAction } from '@/components/ui/row-actions/rowAction';
import { useRuleErrorMessage } from '@/components/rules/use-rule-error-message';

interface RuleCardShellProps {
  /** Names the card for a screen reader ("Condition", "Action"). */
  label: string;
  /** Duplicate, move up, move down, delete: the card's overflow menu. */
  actions: RowAction[];
  /** Error codes for this card, from the server or from the draft check. */
  errors: readonly string[];
  children: ReactNode;
}

/** The messages for a card's error codes; nothing when there are none. */
export function RuleErrorList({ errors }: { errors: readonly string[] }) {
  const message = useRuleErrorMessage();
  if (errors.length === 0) return null;
  return (
    <ul role="alert" className="mt-2 space-y-0.5 text-sm text-red-600 dark:text-red-400">
      {errors.map((code) => (
        <li key={code}>{message(code)}</li>
      ))}
    </ul>
  );
}

/**
 * The frame every condition and action card shares: the content on the left,
 * the overflow menu (`RowActions`, folded to its "more" trigger) on the
 * right, and the card's own errors underneath so a message sits next to what
 * it is about.
 */
export function RuleCardShell({ label, actions, errors, children }: RuleCardShellProps) {
  const hasErrors = errors.length > 0;

  return (
    <div
      role="group"
      aria-label={label}
      className={`rounded-lg border p-3 ${
        hasErrors
          ? 'border-red-400 bg-red-50/50 dark:border-red-500 dark:bg-red-900/10'
          : 'border-gray-200 bg-gray-50/60 dark:border-gray-700 dark:bg-gray-900/30'
      }`}
    >
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">{children}</div>
        <div className="shrink-0 pt-1">
          <RowActions actions={actions} density="compact" maxInline={1} />
        </div>
      </div>
      <RuleErrorList errors={errors} />
    </div>
  );
}
