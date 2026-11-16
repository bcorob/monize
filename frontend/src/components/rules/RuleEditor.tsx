'use client';

import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { ExclamationTriangleIcon } from '@heroicons/react/24/outline';
import { RuleEditorBody } from '@/components/rules/RuleEditorBody';
import { Button, buttonClassName } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { useRuleLookups } from '@/hooks/useRuleLookups';
import { useTransactionRule } from '@/hooks/useTransactionRule';

interface RuleEditorProps {
  /** Absent for a new rule. */
  ruleId?: string;
}

/**
 * The rule editor page body: loads the rule (when it has an id) and the lists
 * its pickers read, and only then shows the form. A failed load of either is
 * an error with a retry, never an empty form: a blank form over a rule that
 * exists is one Save away from overwriting it.
 */
export function RuleEditor({ ruleId }: RuleEditorProps) {
  const t = useTranslations('rules.editor');
  const lookups = useRuleLookups();
  const loaded = useTransactionRule(ruleId);

  if (loaded.state.status === 'error') {
    const { notFound } = loaded.state;
    return (
      <div role="alert">
        <EmptyState
          icon={<ExclamationTriangleIcon />}
          title={t('loadError.title')}
          description={notFound ? t('loadError.notFound') : t('loadError.body')}
          action={
            notFound ? (
              <Link href="/rules" className={buttonClassName('primary', 'md')}>
                {t('page.backToRules')}
              </Link>
            ) : (
              <Button onClick={loaded.reload}>{t('loadError.retry')}</Button>
            )
          }
        />
      </div>
    );
  }

  if (lookups.state.status === 'error') {
    return (
      <div role="alert">
        <EmptyState
          icon={<ExclamationTriangleIcon />}
          title={t('loadError.title')}
          description={t('loadError.lookupsBody')}
          action={<Button onClick={lookups.reload}>{t('loadError.retry')}</Button>}
        />
      </div>
    );
  }

  if (loaded.state.status === 'loading' || lookups.state.status === 'loading') {
    return <LoadingSpinner text={t('page.loading')} />;
  }

  const { rule } = loaded.state;
  return (
    <RuleEditorBody
      // A saved or reloaded rule starts a fresh draft from what the server holds.
      key={rule ? `${rule.id}:${rule.revision}` : 'new'}
      rule={rule}
      lookups={lookups.state.lookups}
      onSaved={loaded.adopt}
      onReload={loaded.reload}
    />
  );
}
