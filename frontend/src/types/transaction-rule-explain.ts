/**
 * The answer of `POST /transaction-rules/explain-row`: every rule of a trigger
 * in the order it runs, with its condition explained node by node and the
 * effects the planner traced. Mirrors
 * `backend/src/transaction-rules/rule-condition.explain.ts` and
 * `rule-row-explain.ts`.
 */
import type { ImportPreviewRuleInput } from '@/types/import-preview';
import type {
  RuleField,
  RuleLeafValue,
  RuleOperator,
  RuleTrigger,
} from '@/types/transaction-rule';
import type { RuleRunChanges } from '@/types/transaction-rule-run';

/**
 * What a leaf compared: money as a decimal string at four decimals, text as the
 * row holds it, an id, a list of tag ids, a day of the month, a weekday code.
 * `null` is a fact the transaction does not have.
 */
export type RuleLeafActual = string | number | boolean | readonly string[] | null;

export interface RuleLeafExplanation {
  kind: 'leaf';
  field: RuleField;
  operator: RuleOperator;
  /** The value as authored; null for an operator with none. */
  expected: RuleLeafValue | null;
  actual: RuleLeafActual;
  result: boolean;
  /** What a `matches` leaf captured; absent when it captured nothing. */
  captures?: Readonly<Record<string, string>>;
}

/** `not` holds the group it negates as its only child. */
export interface RuleGroupExplanation {
  kind: 'all' | 'any' | 'not';
  result: boolean;
  children: RuleConditionExplanation[];
  captures?: Readonly<Record<string, string>>;
}

/** A part of the condition the server left out because it is deeper or larger than a rule may be. */
export interface RuleOmittedExplanation {
  kind: 'omitted';
  result: boolean;
  captures?: Readonly<Record<string, string>>;
}

export type RuleConditionExplanation =
  | RuleLeafExplanation
  | RuleGroupExplanation
  | RuleOmittedExplanation;

/** What the planner traced for one rule. */
export interface ExplainedRuleEffects {
  ruleId: string;
  matched: boolean;
  applied: Array<{ type: string; outcome?: string }>;
  skipped: Array<{ type: string; reason: string }>;
  changes: RuleRunChanges;
  stopped: boolean;
}

/** Mirrors `RuleSkipReason` in `backend/src/transaction-rules/rule-effects.ts` (pinned by the contract test). */
export const EXPLAINED_RULE_SKIPS = ['disabled', 'invalid', 'outside_active_window'] as const;

export type ExplainedRuleSkip = (typeof EXPLAINED_RULE_SKIPS)[number];

export interface ExplainedRule {
  ruleId: string;
  ruleName: string;
  enabled: boolean;
  position: number;
  /** Why the rule was not evaluated at all; absent for a rule that was reached or stopped before. */
  skippedRule?: ExplainedRuleSkip;
  /** False for a rule that was not reached: a rule before it stopped the pass, or it was skipped. */
  evaluated: boolean;
  matched: boolean;
  /** Null when the rule was not evaluated. */
  condition: RuleConditionExplanation | null;
  /** Null when the rule was not evaluated. */
  effects: ExplainedRuleEffects | null;
  /** True when this matched rule ended the pass. */
  stopped: boolean;
}

/** Names for every id the explanation mentions; an id with no name is gone. */
export interface RuleExplainLabels {
  accounts: Record<string, string>;
  payees: Record<string, string>;
  categories: Record<string, string>;
  tags: Record<string, string>;
}

export interface RuleRowExplanation {
  rules: ExplainedRule[];
  labels: RuleExplainLabels;
}

export interface ExplainRowRequest {
  trigger: RuleTrigger;
  input: ImportPreviewRuleInput;
}
