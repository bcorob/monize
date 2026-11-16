'use client';

import { useId, useRef } from 'react';
import { useTranslations } from 'next-intl';
import { RuleErrorList } from '@/components/rules/RuleCardShell';
import { RuleExpressionSuggestions, suggestionId } from '@/components/rules/RuleExpressionSuggestions';
import { useExpressionSuggestions } from '@/components/rules/use-expression-suggestions';
import { lineColumn, type CelError, type EntityIndex } from '@/lib/rule-cel';
import { cn, inputBaseClasses, inputErrorClasses } from '@/lib/utils';

interface RuleExpressionEditorProps {
  text: string;
  /** Why the text is not a rule; null when it is one. */
  error: CelError | null;
  index: EntityIndex;
  onChange: (text: string) => void;
  /** Error codes the server or the draft check gave for the conditions, shown under the box. */
  codes: readonly string[];
}

/** The line the error is on, with a marker under the part the parser refused. */
function ErrorExcerpt({ text, error }: { text: string; error: CelError }) {
  const { line, column } = lineColumn(text, error.position);
  const source = text.split('\n')[line - 1] ?? '';
  const width = Math.max(1, Math.min(error.length, source.length - column + 1));
  return (
    <pre aria-hidden="true" className="mt-1 overflow-x-auto rounded bg-gray-100 p-2 font-mono text-xs text-gray-800 dark:bg-gray-900 dark:text-gray-200">
      {`${source}\n${' '.repeat(column - 1)}${'^'.repeat(width)}`}
    </pre>
  );
}

/**
 * The condition as CEL-syntax text. Every edit is parsed; a text outside the
 * supported subset shows where and why beneath the box, and the section blocks
 * Save and the switch back to Visual until it is fixed.
 */
export function RuleExpressionEditor({ text, error, index, onChange, codes }: RuleExpressionEditorProps) {
  const t = useTranslations('rules.editor.expression');
  const ref = useRef<HTMLTextAreaElement>(null);
  const id = useId();
  const listId = `${id}-suggestions`;
  const errorId = `${id}-error`;
  const helpId = `${id}-help`;
  const suggestions = useExpressionSuggestions({ text, index, textareaRef: ref, onChange });
  const open = suggestions.items.length > 0;
  const position = error ? lineColumn(text, error.position) : null;

  return (
    <div>
      <label htmlFor={id} className="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300">
        {t('label')}
      </label>
      <textarea
        ref={ref}
        id={id}
        rows={6}
        value={text}
        spellCheck={false}
        autoCapitalize="off"
        autoComplete="off"
        autoCorrect="off"
        aria-invalid={error !== null}
        aria-describedby={error ? `${errorId} ${helpId}` : helpId}
        aria-autocomplete="list"
        aria-controls={open ? listId : undefined}
        aria-activedescendant={open && suggestions.active >= 0 ? suggestionId(listId, suggestions.active) : undefined}
        onChange={suggestions.onTextChange}
        onSelect={suggestions.onSelect}
        onKeyDown={suggestions.onKeyDown}
        className={cn(inputBaseClasses, 'border px-3 py-2 font-mono text-sm focus-visible:ring-1 focus-visible:outline-none', error && inputErrorClasses)}
      />
      <RuleExpressionSuggestions id={listId} items={suggestions.items} active={suggestions.active} onChoose={suggestions.choose} />
      {error && position && (
        <div id={errorId}>
          <p role="alert" className="mt-1 text-sm text-red-600 dark:text-red-400">
            {t('errorAt', { ...position, message: t(`errors.${error.key}`, error.args) })}
          </p>
          <ErrorExcerpt text={text} error={error} />
        </div>
      )}
      <p id={helpId} className="mt-1 text-xs text-gray-500 dark:text-gray-400">
        {t('help')}
      </p>
      <RuleErrorList errors={codes} />
    </div>
  );
}
