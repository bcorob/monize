'use client';

import { useState } from 'react';
import { parseCondition, printCondition, type CelError, type EntityIndex } from '@/lib/rule-cel';
import type { EditorGroup } from '@/lib/rule-tree';

export type ConditionMode = 'visual' | 'expression';

export interface RuleExpressionState {
  readonly mode: ConditionMode;
  /** The text in the expression view; only meaningful in that mode. */
  readonly text: string;
  /** Why the text is not a rule, or null when it is one. */
  readonly error: CelError | null;
  /** Show the visual editor; refused while the text is not a rule. */
  readonly showVisual: () => void;
  /** Show the condition as text. */
  readonly showExpression: () => void;
  readonly change: (text: string) => void;
}

interface Options {
  /** The condition as the draft holds it. */
  readonly condition: EditorGroup;
  readonly index: EntityIndex;
  /** The text now reads as this condition. */
  readonly onCondition: (condition: EditorGroup) => void;
}

/**
 * The Visual / Expression switch of the If section. The draft's tree stays the
 * only source of truth: the text is printed from it on the way in, and every
 * edit that parses replaces it. While the text does not parse, the tree keeps
 * the last text that did, and the caller blocks Save and the way back to Visual,
 * so a tree that the text no longer describes is never saved or shown.
 */
export function useRuleExpression({ condition, index, onCondition }: Options): RuleExpressionState {
  const [mode, setMode] = useState<ConditionMode>('visual');
  const [text, setText] = useState('');
  const [error, setError] = useState<CelError | null>(null);

  const showExpression = () => {
    setText(printCondition(condition, index));
    setError(null);
    setMode('expression');
  };
  const showVisual = () => {
    if (error === null) setMode('visual');
  };
  const change = (next: string) => {
    setText(next);
    const result = parseCondition(next, index);
    if (result.ok) {
      setError(null);
      onCondition(result.root);
    } else {
      setError(result.error);
    }
  };

  return { mode, text, error, showVisual, showExpression, change };
}
