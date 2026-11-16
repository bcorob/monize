import { createLogger } from '@/lib/logger';
import type { ImportPreviewRuleInput } from '@/types/import-preview';
import type { RuleRowExplanation } from '@/types/transaction-rule-explain';

const logger = createLogger('ImportPreviewRuleTest');

/**
 * What one row's rule test is: being loaded, answered, or failed. A failed load
 * is its own state and is never read as "no rules".
 */
export type RuleTestState =
  | { status: 'loading' }
  | { status: 'ready'; explanation: RuleRowExplanation }
  | { status: 'error' };

interface Entry {
  /** The input this entry was asked for; an entry for another input is not the answer. */
  signature: string;
  state: RuleTestState;
}

export interface RuleTestStore {
  subscribe: (listener: () => void) => () => void;
  /** The state of a row; undefined before it was asked for. The same object until it changes. */
  get: (key: string) => RuleTestState | undefined;
  /**
   * Ask for a row's rule test. Loaded and loading rows are left as they are, so
   * each row is fetched once while the store lives; a failed row is fetched
   * again only with `retry`. A row asked again with a different input is a new
   * question.
   */
  request: (key: string, input: ImportPreviewRuleInput, options?: { retry?: boolean }) => void;
}

/**
 * The rule tests of the rows of one open preview, by row key. The store lives
 * as long as the preview is open and is dropped with it. Each answer is
 * written only by the request that produced it: a response that arrives after
 * the row was asked again for another input is discarded.
 */
export function createRuleTestStore(
  load: (input: ImportPreviewRuleInput) => Promise<RuleRowExplanation>,
): RuleTestStore {
  const entries = new Map<string, Entry>();
  const listeners = new Set<() => void>();
  const notify = () => listeners.forEach((listener) => listener());

  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    get: (key) => entries.get(key)?.state,
    request(key, input, options = {}) {
      const signature = JSON.stringify(input);
      const known = entries.get(key);
      if (known !== undefined && known.signature === signature) {
        if (known.state.status !== 'error' || options.retry !== true) return;
      }
      const pending: Entry = { signature, state: { status: 'loading' } };
      entries.set(key, pending);
      notify();
      const settle = (state: RuleTestState) => {
        if (entries.get(key) !== pending) return;
        entries.set(key, { signature, state });
        notify();
      };
      load(input).then(
        (explanation) => settle({ status: 'ready', explanation }),
        (error: unknown) => {
          logger.error('Failed to load the rule test result:', error);
          settle({ status: 'error' });
        },
      );
    },
  };
}
