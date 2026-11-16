'use client';

import { useTranslations } from 'next-intl';
import { isKnownRuleErrorCode } from '@/lib/rule-errors';
import {
  MAX_RULE_ACTIONS,
  MAX_RULE_CONDITION_DEPTH,
  MAX_RULE_CONDITION_LEAVES,
  MAX_RULE_CONDITION_NODES,
} from '@/lib/rule-fields';

const LIMITS = {
  maxDepth: MAX_RULE_CONDITION_DEPTH,
  maxLeaves: MAX_RULE_CONDITION_LEAVES,
  maxNodes: MAX_RULE_CONDITION_NODES,
  maxActions: MAX_RULE_ACTIONS,
} as const;

/** The sentence for an error code; a code the catalog lacks reads as a generic one. */
export function useRuleErrorMessage(): (code: string) => string {
  const t = useTranslations('rules.editor.errors.codes');
  return (code) => t(isKnownRuleErrorCode(code) ? code : 'UNKNOWN', LIMITS);
}
