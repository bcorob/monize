import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AI_ACTION_CARD_KIND, aiActionCardKind, isRuleAiActionType } from './ai-action-card';
import { AI_ACTION_TYPES } from '@/types/ai';

/**
 * The action types the assistant can sign are the backend's list, and the
 * confirmation card for each is chosen from one total map. The backend source
 * is read here so a type added there without a card here (or a card for a type
 * the server does not sign) fails a test instead of reaching the chat with no
 * card or the wrong one.
 */
const source = readFileSync(
  join(__dirname, '..', '..', '..', 'backend', 'src', 'ai', 'actions', 'ai-action.types.ts'),
  'utf8',
);

function backendActionTypes(): string[] {
  const list = /export const AI_ACTION_TYPES: AiActionType\[\] = \[([^\]]*)\]/.exec(source);
  if (!list) throw new Error('AI_ACTION_TYPES was not found in the backend source');
  return [...list[1].matchAll(/"([a-z_]+)"/g)].map((match) => match[1]);
}

describe('the assistant action types against the backend', () => {
  it('lists exactly the types the backend signs, in its order', () => {
    expect([...AI_ACTION_TYPES]).toEqual(backendActionTypes());
  });

  it('names a confirmation card for every type and no other', () => {
    expect(Object.keys(AI_ACTION_CARD_KIND).sort()).toEqual([...AI_ACTION_TYPES].sort());
  });

  it('draws the four rule types with the rule card', () => {
    const rules = AI_ACTION_TYPES.filter((type) => isRuleAiActionType(type));
    expect(rules).toEqual([
      'create_transaction_rule',
      'update_transaction_rule',
      'delete_transaction_rule',
      'run_transaction_rule',
    ]);
  });

  it('draws a type this client does not know with the single card', () => {
    expect(aiActionCardKind('archive_everything')).toBe('single');
    expect(aiActionCardKind('constructor')).toBe('single');
    expect(isRuleAiActionType('archive_everything')).toBe(false);
  });
});
