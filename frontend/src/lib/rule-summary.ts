import type { RuleTrigger, TransactionRule } from '@/types/transaction-rule';

/**
 * Which trigger phrase a rule reads with. `none` is a stored rule whose
 * triggers are missing or unreadable; the list still has to open on it.
 */
export type RuleTriggerKind = 'create' | 'import' | 'both' | 'none';

export function ruleTriggerKind(triggers: readonly RuleTrigger[] | null | undefined): RuleTriggerKind {
  const list = Array.isArray(triggers) ? triggers : [];
  const create = list.includes('create');
  const importing = list.includes('import');
  if (create && importing) return 'both';
  if (create) return 'create';
  if (importing) return 'import';
  return 'none';
}

/**
 * How many conditions a tree holds: its leaves. Reads `unknown` because an
 * invalid rule can carry any stored JSON (a restore leaves `{}`), and counting
 * what is readable beats throwing on the row that needs repair.
 */
export function countConditionLeaves(node: unknown): number {
  if (typeof node !== 'object' || node === null || Array.isArray(node)) return 0;
  const record = node as Record<string, unknown>;
  if (typeof record.field === 'string') return 1;
  const children = Array.isArray(record.all)
    ? record.all
    : Array.isArray(record.any)
      ? record.any
      : [];
  return children.reduce<number>((sum, child) => sum + countConditionLeaves(child), 0);
}

export interface RuleSummaryValues {
  trigger: RuleTriggerKind;
  conditions: number;
  actions: number;
}

/** The values the `rules` catalog's `list.summary` message is formatted with. */
export function ruleSummaryValues(rule: TransactionRule): RuleSummaryValues {
  return {
    trigger: ruleTriggerKind(rule.triggers),
    conditions: countConditionLeaves(rule.condition),
    actions: Array.isArray(rule.actions) ? rule.actions.length : 0,
  };
}

/** Key under `rules.invalid.reasons` for a code from `invalidReasons`. */
export type RuleInvalidReasonKey =
  | 'referenceMissing'
  | 'noActions'
  | 'tooLarge'
  | 'duplicateAction'
  | 'unreadable'
  | 'other';

export function ruleInvalidReasonKey(code: string): RuleInvalidReasonKey {
  switch (code) {
    case 'REFERENCE_NOT_FOUND':
      return 'referenceMissing';
    case 'NO_ACTIONS':
      return 'noActions';
    case 'MAX_DEPTH':
    case 'MAX_LEAVES':
    case 'MAX_NODES':
    case 'TOO_MANY_ACTIONS':
      return 'tooLarge';
    case 'DUPLICATE_ACTION':
      return 'duplicateAction';
    case 'INVALID_SHAPE':
      return 'unreadable';
    default:
      return 'other';
  }
}

/** The distinct reason keys of a rule, in the order the API reported them. */
export function ruleInvalidReasonKeys(rule: TransactionRule): RuleInvalidReasonKey[] {
  const reasons = Array.isArray(rule.invalidReasons) ? rule.invalidReasons : [];
  const keys = reasons.map((r) => ruleInvalidReasonKey(r.code));
  return keys.filter((key, index) => keys.indexOf(key) === index);
}
