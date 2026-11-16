'use client';

import { CheckCircleIcon, XCircleIcon } from '@heroicons/react/24/solid';
import { useFormatter, useTranslations } from 'next-intl';
import { useRuleEnumLabels } from '@/components/rules/use-rule-enum-labels';
import { useRuleWords, type RuleWordsLabels } from '@/components/rules/RuleInWords';
import { useNumberFormat } from '@/hooks/useNumberFormat';
import { RULE_CONDITION_FIELDS, isRuleField } from '@/lib/rule-fields';
import type { RuleConditionLeaf } from '@/types/transaction-rule';
import type {
  RuleConditionExplanation,
  RuleGroupExplanation,
  RuleLeafActual,
  RuleLeafExplanation,
} from '@/types/transaction-rule-explain';

/** A condition's answer, by a mark and by words for a reader who cannot see the mark. */
function Mark({ result }: { result: boolean }) {
  const t = useTranslations('import.preview.ruleTest.condition');
  const Icon = result ? CheckCircleIcon : XCircleIcon;
  return (
    <>
      <Icon
        aria-hidden="true"
        className={`mt-0.5 h-4 w-4 shrink-0 ${
          result ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400'
        }`}
      />
      <span className="sr-only">{result ? t('met') : t('notMet')}</span>
    </>
  );
}

const decimal = (value: string): number | null => {
  if (value.trim() === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

/** The fact a leaf compared, in the words the reader uses for that field; ids by name. */
function useActualText(labels: RuleWordsLabels) {
  const t = useTranslations('import.preview.ruleTest.condition');
  const tw = useTranslations('rules.words');
  const tr = useTranslations('rules');
  const format = useFormatter();
  const { formatNumber } = useNumberFormat();
  const enumLabels = useRuleEnumLabels();
  const unknown = tr('run.change.unknown');

  return (leaf: RuleLeafExplanation): string => {
    const actual: RuleLeafActual = leaf.actual;
    if (actual === null) return t('noValue');
    if (Array.isArray(actual)) {
      // Only the tag set is a list.
      if (actual.length === 0) return t('noTags');
      return format.list(
        actual.map((id) => labels.tags[id] ?? unknown),
        { type: 'conjunction' },
      );
    }
    if (!isRuleField(leaf.field)) return String(actual);
    switch (RULE_CONDITION_FIELDS[leaf.field].kind) {
      case 'accountId':
        return labels.accounts[String(actual)] ?? unknown;
      case 'payeeId':
        return labels.payees[String(actual)] ?? unknown;
      case 'categoryId':
        return labels.categories[String(actual)] ?? unknown;
      case 'money': {
        const amount = typeof actual === 'string' ? decimal(actual) : null;
        return amount === null ? String(actual) : formatNumber(amount);
      }
      case 'boolean':
        return actual === true ? tr('editor.value.yes') : actual === false ? tr('editor.value.no') : String(actual);
      case 'enum':
        return enumLabels.label(leaf.field, String(actual));
      case 'text':
        return tw('text', { value: String(actual) });
      default:
        return String(actual);
    }
  };
}

type Words = ReturnType<typeof useRuleWords>;
type ActualText = (leaf: RuleLeafExplanation) => string;

function LeafNode({ node, words, actualText }: { node: RuleLeafExplanation; words: Words; actualText: ActualText }) {
  const t = useTranslations('import.preview.ruleTest.condition');
  const leaf = {
    field: node.field,
    op: node.operator,
    ...(node.expected === null ? {} : { value: node.expected }),
  } as RuleConditionLeaf;
  const captures = Object.entries(node.captures ?? {});
  return (
    <li>
      <div className="flex items-start gap-1.5">
        <Mark result={node.result} />
        <span>{words.leafText(leaf)}</span>
      </div>
      <ul className="space-y-0.5 pl-[1.375rem] text-xs text-gray-500 dark:text-gray-400">
        <li>{t('actual', { value: actualText(node) })}</li>
        {captures.map(([name, value]) => (
          <li key={name}>{t('capture', { name, value })}</li>
        ))}
      </ul>
    </li>
  );
}

function GroupNode({
  node,
  words,
  actualText,
  root,
}: {
  node: RuleGroupExplanation;
  words: Words;
  actualText: ActualText;
  root: boolean;
}) {
  const tr = useTranslations('rules');
  // `not` holds the group it negates; the two read as one line ("None of these").
  const negated = node.kind === 'not';
  const inner: RuleConditionExplanation | undefined = negated ? node.children[0] : node;
  const group = inner !== undefined && (inner.kind === 'all' || inner.kind === 'any') ? inner : null;
  const all = group === null || group.kind === 'all';
  const children = group?.children ?? [];
  // The empty "all" at the root is what a rule with no conditions stores: it matches everything.
  const everyTransaction = root && all && !negated && children.length === 0;
  const text = everyTransaction
    ? tr('words.everyTransaction')
    : words.groupText(all ? { all: [], not: negated } : { any: [], not: negated });
  return (
    <li>
      <div className="flex items-start gap-1.5">
        <Mark result={node.result} />
        <span>{text}</span>
      </div>
      {children.length > 0 ? (
        <ul className="mt-0.5 space-y-1 pl-[1.375rem]">
          {children.map((child, index) => (
            <ConditionNode key={index} node={child} words={words} actualText={actualText} root={false} />
          ))}
        </ul>
      ) : (
        !everyTransaction && (
          <p className="pl-[1.375rem] text-gray-500 dark:text-gray-400">{tr('editor.group.empty')}</p>
        )
      )}
    </li>
  );
}

function ConditionNode({
  node,
  words,
  actualText,
  root,
}: {
  node: RuleConditionExplanation;
  words: Words;
  actualText: ActualText;
  root: boolean;
}) {
  const t = useTranslations('import.preview.ruleTest.condition');
  if (node.kind === 'leaf') return <LeafNode node={node} words={words} actualText={actualText} />;
  if (node.kind === 'omitted') {
    return (
      <li>
        <div className="flex items-start gap-1.5">
          <Mark result={node.result} />
          <span>{t('omitted')}</span>
        </div>
      </li>
    );
  }
  return <GroupNode node={node} words={words} actualText={actualText} root={root} />;
}

/**
 * A rule's condition as the server evaluated it for one transaction: the same
 * tree the rule is written as, each node with a mark for its answer, each leaf
 * in the words of the rule editor with what this transaction had, and the texts
 * a `matches` leaf kept. Nothing is evaluated in the browser.
 */
export function ImportPreviewRuleTestCondition({
  condition,
  labels,
}: {
  condition: RuleConditionExplanation;
  labels: RuleWordsLabels;
}) {
  const words = useRuleWords(labels);
  const actualText = useActualText(labels);
  return (
    <ul className="space-y-1 text-gray-900 dark:text-gray-100">
      <ConditionNode node={condition} words={words} actualText={actualText} root />
    </ul>
  );
}
