'use client';

import type { ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import { ExclamationTriangleIcon } from '@heroicons/react/24/outline';
import { RuleConditionGroup, type RuleTreeEnv } from '@/components/rules/RuleConditionGroup';
import { RuleExpressionEditor } from '@/components/rules/RuleExpressionEditor';
import { RuleSection } from '@/components/rules/RuleSection';
import { TOUR_ANCHORS, tourAnchor } from '@/lib/tours/anchors';
import type { RuleExpressionState } from '@/components/rules/use-rule-expression';
import { SEGMENTED_GROUP_CLASS, segmentClass } from '@/components/ui/segmented-control';
import type { EntityIndex } from '@/lib/rule-cel';

interface RuleIfSectionProps {
  expression: RuleExpressionState;
  env: RuleTreeEnv;
  index: EntityIndex;
  /** Error codes for any condition, shown under the box in the expression view. */
  conditionCodes: readonly string[];
  /** Drawn under the conditions in both views: the Test rule match. */
  footer?: ReactNode;
}

const DISABLED = 'disabled:cursor-not-allowed disabled:opacity-50';

/**
 * "If": the conditions, as cards (Visual) or as text (Expression). Both edit
 * the same tree. The way back to Visual is disabled while the text is not a
 * rule, because there is no tree to show for it.
 */
export function RuleIfSection({ expression, env, index, conditionCodes, footer }: RuleIfSectionProps) {
  const t = useTranslations('rules.editor');
  const { mode, error } = expression;
  const blocked = mode === 'expression' && error !== null;

  return (
    <RuleSection
      title={t('sections.if')}
      description={t('if.description')}
      anchor={tourAnchor(TOUR_ANCHORS.ruleEditorIf)}
    >
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <div role="group" aria-label={t('expression.modeLabel')} className={SEGMENTED_GROUP_CLASS}>
          <button
            type="button"
            aria-pressed={mode === 'visual'}
            disabled={blocked}
            className={`${segmentClass(mode === 'visual')} ${DISABLED}`}
            onClick={expression.showVisual}
          >
            {t('expression.visual')}
          </button>
          <button
            type="button"
            aria-pressed={mode === 'expression'}
            className={segmentClass(mode === 'expression')}
            onClick={() => mode === 'visual' && expression.showExpression()}
          >
            {t('expression.expression')}
          </button>
        </div>
        {blocked && <p className="text-xs text-amber-700 dark:text-amber-400">{t('expression.blocked')}</p>}
      </div>
      {env.root.children.length === 0 && (
        <p className="mb-3 flex items-start gap-2 text-sm text-amber-700 dark:text-amber-400">
          <ExclamationTriangleIcon className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
          {t('if.everyTransaction')}
        </p>
      )}
      {mode === 'visual' ? (
        <RuleConditionGroup group={env.root} path={[]} env={env} />
      ) : (
        <RuleExpressionEditor
          text={expression.text}
          error={error}
          index={index}
          onChange={expression.change}
          codes={conditionCodes}
        />
      )}
      {footer}
    </RuleSection>
  );
}
