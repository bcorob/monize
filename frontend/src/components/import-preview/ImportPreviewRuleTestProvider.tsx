'use client';

import { createContext, useContext, useState, type ReactNode } from 'react';
import { createRuleTestStore, type RuleTestStore } from '@/lib/import-preview-rule-test';
import { transactionRulesApi } from '@/lib/transaction-rules-api';

const RuleTestContext = createContext<RuleTestStore | null>(null);

const newStore = (): RuleTestStore =>
  createRuleTestStore((input) => transactionRulesApi.explainRow({ trigger: 'import', input }));

/**
 * Holds the rule test results of the rows of one open import preview, so a row
 * that is collapsed and expanded again is not asked about twice. The results
 * live as long as this provider does: closing the preview drops them, and so
 * does a new preview (`scope` is the preview, compared by identity): the rules
 * may have changed since, and the next preview starts with none.
 */
export function ImportPreviewRuleTestProvider({ scope, children }: { scope: object; children: ReactNode }) {
  const [store, setStore] = useState(newStore);
  const [seen, setSeen] = useState(scope);
  if (seen !== scope) {
    setSeen(scope);
    setStore(newStore());
  }
  return <RuleTestContext.Provider value={store}>{children}</RuleTestContext.Provider>;
}

/**
 * The preview's store, or one of the component's own when it is shown outside a
 * provider (it then remembers its answer only while it is mounted).
 */
export function useRuleTestStore(): RuleTestStore {
  const shared = useContext(RuleTestContext);
  const [own] = useState(newStore);
  return shared ?? own;
}
