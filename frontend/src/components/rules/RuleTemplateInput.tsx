'use client';

import { useRef } from 'react';
import { useFormatter, useTranslations } from 'next-intl';
import { InfoTooltip } from '@/components/ui/InfoTooltip';
import { Input } from '@/components/ui/Input';
import { availablePlaceholders, checkTemplate, showPlaceholder } from '@/lib/rule-captures';

interface RuleTemplateInputProps {
  id: string;
  label: string;
  value: string;
  /** What the server accepts for this action's text. */
  maxLength: number;
  /** The capture names the patterns of this rule define. */
  captures: readonly string[];
  /** One sentence under the input on what the text may hold. */
  help: string;
  /** A further sentence of its own, for a setting that changes how the text is used. */
  note?: string;
  onChange: (value: string) => void;
}

/**
 * The text of a text action: plain text with `{placeholder}` groups, the
 * placeholders this rule can fill listed underneath (select one to insert it
 * where the cursor is), and a placeholder the rule cannot fill flagged as soon
 * as it is typed. The server refuses the same text (`UNKNOWN_CAPTURE`,
 * `INVALID_CAPTURE`), so this only says so earlier.
 */
export function RuleTemplateInput({ id, label, value, maxLength, captures, help, note, onChange }: RuleTemplateInputProps) {
  const t = useTranslations('rules.editor.action');
  const format = useFormatter();
  const input = useRef<HTMLInputElement>(null);
  const { malformed, unknown } = checkTemplate(value, captures);
  const list = (names: readonly string[]) => format.list(names, { type: 'conjunction' });
  const error = [
    malformed.length > 0 ? t('invalidPlaceholders', { names: list(malformed) }) : null,
    unknown.length > 0 ? t('unknownPlaceholders', { names: list(unknown) }) : null,
  ]
    .filter((sentence) => sentence !== null)
    .join(' ');

  const insert = (name: string) => {
    const token = showPlaceholder(name);
    const field = input.current;
    const start = field?.selectionStart ?? value.length;
    const end = field?.selectionEnd ?? value.length;
    const next = value.slice(0, start) + token + value.slice(end);
    if (next.length > maxLength) return;
    onChange(next);
    const caret = start + token.length;
    requestAnimationFrame(() => {
      field?.focus();
      field?.setSelectionRange(caret, caret);
    });
  };

  return (
    <div>
      <Input
        ref={input}
        id={id}
        label={label}
        value={value}
        maxLength={maxLength}
        error={error === '' ? undefined : error}
        aria-describedby={`${id}-help`}
        onChange={(e) => onChange(e.target.value)}
      />
      <div id={`${id}-help`} className="mt-1 space-y-0.5 text-xs text-gray-500 dark:text-gray-400">
        <p>{help}</p>
        {note && <p>{note}</p>}
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        <span className="text-xs font-medium text-gray-600 dark:text-gray-400">{t('placeholders')}</span>
        <InfoTooltip
          text={t('placeholdersHelp', {
            payeeText: showPlaceholder('payeeText'),
            description: showPlaceholder('description'),
          })}
          placement="top"
          usePortal
        />
        {availablePlaceholders(captures).map((name) => (
          <button
            key={name}
            type="button"
            aria-label={t('insertPlaceholder', { name: showPlaceholder(name) })}
            disabled={value.length + showPlaceholder(name).length > maxLength}
            onClick={() => insert(name)}
            className="rounded border border-gray-300 bg-white px-1.5 py-0.5 font-mono text-xs text-gray-800 hover:border-blue-500 focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:outline-none disabled:opacity-50 motion-reduce:transition-none dark:border-gray-600 dark:bg-gray-800 dark:text-gray-200 dark:hover:border-blue-400"
          >
            {showPlaceholder(name)}
          </button>
        ))}
      </div>
    </div>
  );
}
