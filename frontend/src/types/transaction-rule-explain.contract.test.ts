import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import en from '@/i18n/messages/en/import.json';
import { EXPLAINED_RULE_SKIPS } from './transaction-rule-explain';

/**
 * `ExplainedRuleSkip` is the server's `RuleSkipReason`, and the import preview
 * renders `notEvaluated.<reason>` for it. A reason the server adds and this
 * copy lacks is a rule shown as "not evaluated" with a missing message; one
 * this copy keeps after the server drops it is dead copy. Both are checked.
 */
const BACKEND_EFFECTS = resolve(
  __dirname,
  '../../../backend/src/transaction-rules/rule-effects.ts',
);

function backendSkipReasons(): string[] {
  const source = readFileSync(BACKEND_EFFECTS, 'utf8');
  const match = /export type RuleSkipReason =([^;]*);/.exec(source);
  if (!match) throw new Error(`RuleSkipReason not found in ${BACKEND_EFFECTS}`);
  return [...match[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
}

describe('ExplainedRuleSkip', () => {
  it('equals the backend RuleSkipReason', () => {
    const reasons = backendSkipReasons();
    expect(reasons.length).toBeGreaterThan(0);
    expect([...EXPLAINED_RULE_SKIPS].sort()).toEqual([...reasons].sort());
  });

  it('has an English notEvaluated message for every reason', () => {
    const catalog = en.preview.ruleTest.notEvaluated as Record<string, unknown>;
    for (const reason of EXPLAINED_RULE_SKIPS) {
      expect(typeof catalog[reason]).toBe('string');
    }
  });
});
