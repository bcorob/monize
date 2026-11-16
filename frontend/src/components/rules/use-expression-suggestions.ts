'use client';

import { useLayoutEffect, useRef, useState, type ChangeEvent, type KeyboardEvent, type RefObject, type SyntheticEvent } from 'react';
import { applySuggestion, complete, type Completion, type EntityIndex, type Suggestion } from '@/lib/rule-cel';

interface Options {
  readonly text: string;
  readonly index: EntityIndex;
  readonly textareaRef: RefObject<HTMLTextAreaElement | null>;
  readonly onChange: (text: string) => void;
}

export interface ExpressionSuggestions {
  readonly items: readonly Suggestion[];
  /** The highlighted item, or -1 when none is (Enter then keeps its meaning of a new line). */
  readonly active: number;
  readonly choose: (index: number) => void;
  readonly onTextChange: (event: ChangeEvent<HTMLTextAreaElement>) => void;
  readonly onSelect: (event: SyntheticEvent<HTMLTextAreaElement>) => void;
  readonly onKeyDown: (event: KeyboardEvent<HTMLTextAreaElement>) => void;
}

/**
 * The list under the expression box: what to offer at the caret, which item is
 * highlighted, and the keys that move and choose. Up and Down move the
 * highlight, Enter chooses the highlighted item (with none highlighted it is a
 * new line), Escape closes the list until the text or the caret moves again.
 */
export function useExpressionSuggestions({ text, index, textareaRef, onChange }: Options): ExpressionSuggestions {
  const [caret, setCaret] = useState<number | null>(null);
  const [dismissed, setDismissed] = useState(false);
  const [active, setActive] = useState(-1);
  const pendingCaret = useRef<number | null>(null);

  const completion: Completion | null = caret === null || dismissed ? null : complete(text, caret, index);
  const items = completion?.items ?? [];

  // The caret is placed after the text it belongs to has been drawn.
  useLayoutEffect(() => {
    const at = pendingCaret.current;
    if (at === null) return;
    pendingCaret.current = null;
    textareaRef.current?.setSelectionRange(at, at);
  });

  const moveCaret = (next: number) => {
    setCaret(next);
    setDismissed(false);
    setActive(-1);
  };

  const choose = (position: number) => {
    const item = items[position];
    if (!completion || !item) return;
    const applied = applySuggestion(text, completion, item);
    pendingCaret.current = applied.caret;
    onChange(applied.text);
    moveCaret(applied.caret);
  };

  return {
    items,
    active: active < items.length ? active : -1,
    choose,
    onTextChange: (event) => {
      onChange(event.target.value);
      moveCaret(event.target.selectionStart);
    },
    onSelect: (event) => {
      const next = event.currentTarget.selectionStart;
      if (next !== caret) moveCaret(next);
    },
    onKeyDown: (event) => {
      if (items.length === 0) return;
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        setActive((current) => (current + 1) % items.length);
      } else if (event.key === 'ArrowUp') {
        event.preventDefault();
        setActive((current) => (current <= 0 ? items.length - 1 : current - 1));
      } else if (event.key === 'Enter' && active >= 0 && active < items.length) {
        event.preventDefault();
        choose(active);
      } else if (event.key === 'Escape') {
        event.preventDefault();
        setDismissed(true);
        setActive(-1);
      }
    },
  };
}
