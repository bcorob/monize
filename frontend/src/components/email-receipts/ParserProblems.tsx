'use client';

import { useTranslations } from 'next-intl';
import { PARSER_VALIDATION_CODES } from '@/lib/receipt-parser-form';
import { RECEIPT_PARSER_LIMITS, type ReceiptParserValidationError } from '@/types/email-receipts';

const PATTERN_FIELDS = ['orderId', 'total', 'paid', 'shipping', 'discount', 'fees', 'payee', 'reference', 'linkKey'] as const;
const GUARD_FIELDS = ['requireLine', 'skipIfLine', 'waitIfLine'] as const;
type PatternField = (typeof PATTERN_FIELDS)[number];

const isPatternField = (name: string): name is PatternField => (PATTERN_FIELDS as readonly string[]).includes(name);
/** The trade section's pattern lists, by their key in `trade`, with the label each has on the form. */
const TRADE_FIELD_LABELS: Readonly<Record<string, string>> = {
  action: 'fields.tradeAction',
  symbol: 'fields.tradeSymbol',
  quantity: 'fields.tradeQuantity',
  total: 'fields.tradeTotal',
  price: 'fields.tradePrice',
  commission: 'fields.tradeCommission',
  date: 'fields.tradeDate',
  account: 'fields.tradeAccount',
};
const TRADE_ROW_PARTS: Readonly<Record<string, string>> = {
  match: 'fields.rulePattern',
  accountId: 'fields.ruleAccount',
  currency: 'fields.ruleCurrency',
};
const isGuardField = (name: string): name is (typeof GUARD_FIELDS)[number] =>
  (GUARD_FIELDS as readonly string[]).includes(name);

type Translator = ReturnType<typeof useTranslations>;

/** A `trade.*` path in the words of the form, or null when it is not one this client knows. */
function describeTradePath(path: string, t: Translator): string | null {
  if (path === 'trade') return t('fields.trade');
  if (path === 'trade.accountRules') return t('fields.accountRules');
  if (path === 'trade.currencyMarkers') return t('fields.currencyMarkers');
  if (path === 'trade.defaultAccountId') return t('fields.defaultAccount');
  const row = /^trade\.(accountRules|currencyMarkers)\[(\d+)\](?:\.(\w+))?$/.exec(path);
  if (row) {
    const number = Number(row[2]) + 1;
    const rule = row[1] === 'accountRules';
    if (row[3] === undefined) return rule ? t('paths.accountRule', { rule: number }) : t('paths.currencyMarker', { marker: number });
    const part = TRADE_ROW_PARTS[row[3]];
    if (part === undefined) return null;
    return rule
      ? t('paths.accountRulePart', { rule: number, part: t(part) })
      : t('paths.currencyMarkerPart', { marker: number, part: t(part) });
  }
  const entry = /^trade\.(\w+)(?:\[(\d+)\](?:\.(label|value|within))?)?$/.exec(path);
  if (!entry || TRADE_FIELD_LABELS[entry[1]] === undefined) return null;
  const field = t(TRADE_FIELD_LABELS[entry[1]]);
  if (entry[2] === undefined) return field;
  if (entry[3] === undefined) return t('paths.line', { field, line: Number(entry[2]) + 1 });
  return t('paths.entryPart', { field, line: Number(entry[2]) + 1, part: t(`fields.${entry[3]}`) });
}

/**
 * Where a problem is, in the words of the form rather than the JSON: the
 * server reports `items.patterns[1]`, the person sees "Item patterns, line 2".
 * A path this client does not know is shown as it is, never dropped.
 */
export function describeProblemPath(path: string, t: Translator): string {
  if (path === '' || path === 'version') return t('paths.definition');
  if (path === 'trade' || path.startsWith('trade.')) {
    const trade = describeTradePath(path, t);
    if (trade !== null) return trade;
  }

  const guard = /^(\w+)(?:\[(\d+)\])?$/.exec(path);
  if (guard && isGuardField(guard[1])) {
    return guard[2] === undefined
      ? t(`fields.${guard[1]}`)
      : t('paths.line', { field: t(`fields.${guard[1]}`), line: Number(guard[2]) + 1 });
  }

  const entryPart = /^(\w+)\[(\d+)\]\.(label|value|within)$/.exec(path);
  if (entryPart && isPatternField(entryPart[1])) {
    return t('paths.entryPart', {
      field: t(`fields.${entryPart[1]}`),
      line: Number(entryPart[2]) + 1,
      part: t(`fields.${entryPart[3]}`),
    });
  }

  const pattern = /^(\w+)\[(\d+)\]$/.exec(path);
  if (pattern && isPatternField(pattern[1])) {
    return t('paths.line', { field: t(`fields.${pattern[1]}`), line: Number(pattern[2]) + 1 });
  }
  if (isPatternField(path)) return t(`fields.${path}`);

  const item = /^items\.patterns\[(\d+)\]$/.exec(path);
  if (item) return t('paths.line', { field: t('fields.itemPatterns'), line: Number(item[1]) + 1 });
  if (path === 'items.patterns') return t('fields.itemPatterns');
  const skip = /^items\.skipLines\[(\d+)\]$/.exec(path);
  if (skip) return t('paths.skipLine', { line: Number(skip[1]) + 1 });
  if (path === 'items.skipLines') return t('fields.skipLines');
  const alternative = /^items\.record\[(\d+)\]\.line\[(\d+)\]$/.exec(path);
  if (alternative) {
    return t('paths.recordAlternative', { step: Number(alternative[1]) + 1, alternative: Number(alternative[2]) + 1 });
  }
  const step = /^items\.record\[(\d+)\](?:\.(line|optional))?$/.exec(path);
  if (step) {
    return step[2]
      ? t('paths.recordStepPart', { step: Number(step[1]) + 1, part: t(`fields.${step[2]}`) })
      : t('paths.recordStep', { step: Number(step[1]) + 1 });
  }
  if (path === 'items.single') return t('fields.single');
  if (path === 'items.single.name') return t('fields.singleName');
  if (path === 'items.joinWrapped') return t('fields.joinWrapped');
  if (path === 'items.record') return t('fields.record');
  if (path === 'items.startAfter') return t('fields.startAfter');
  if (path === 'items.stopAt') return t('fields.stopAt');
  if (path === 'items') return t('fields.items');

  const rule = /^categoryRules\[(\d+)\]\.(match|categoryId|field)$/.exec(path);
  if (rule) {
    const part = rule[2] === 'match' ? 'fields.rulePattern' : rule[2] === 'field' ? 'fields.ruleField' : 'fields.ruleCategory';
    return t('paths.rule', { rule: Number(rule[1]) + 1, part: t(part) });
  }
  if (path === 'source') return t('fields.source');
  if (path === 'role') return t('fields.role');
  if (path === 'link') return t('fields.link');
  if (path === 'link.daysBefore') return t('fields.linkDaysBefore');
  if (path === 'link.fromDomains') return t('fields.linkFromDomains');
  const linkDomain = /^link\.fromDomains\[(\d+)\]$/.exec(path);
  if (linkDomain) return t('paths.line', { field: t('fields.linkFromDomains'), line: Number(linkDomain[1]) + 1 });
  const choice = /^match\.(by|referenceIn)\[(\d+)\]$/.exec(path);
  if (choice) {
    return t('paths.line', {
      field: t(choice[1] === 'by' ? 'fields.matchBy' : 'fields.matchReferenceIn'),
      line: Number(choice[2]) + 1,
    });
  }
  if (path === 'match') return t('fields.match');
  if (path === 'match.by') return t('fields.matchBy');
  if (path === 'match.referenceIn') return t('fields.matchReferenceIn');
  if (path === 'match.daysBefore') return t('fields.matchDaysBefore');
  if (path === 'match.daysAfter') return t('fields.matchDaysAfter');
  if (path === 'match.amountTolerance') return t('fields.matchTolerance');
  if (path === 'tag') return t('fields.tag');
  if (path === 'aiCategories') return t('fields.aiCategories');
  if (path === 'categoryRules') return t('fields.categoryRules');
  if (path === 'defaultCategory' || path === 'defaultCategoryId') return t('fields.defaultCategory');
  if (path === 'shippingCategory' || path === 'shippingCategoryId') return t('fields.shippingCategory');
  if (path === 'feesCategory') return t('fields.feesCategory');
  if (path === 'balanceTolerance') return t('fields.balanceTolerance');
  return path;
}

/** The bound a `too_many`, `too_many_lines` or `too_long` code refers to at this path. */
function boundFor(code: string, path: string): number {
  if (code === 'too_many') {
    if (path.startsWith('categoryRules')) return RECEIPT_PARSER_LIMITS.maxCategoryRules;
    if (path === 'trade.accountRules') return RECEIPT_PARSER_LIMITS.maxTradeAccountRules;
    if (path === 'trade.currencyMarkers') return RECEIPT_PARSER_LIMITS.maxTradeCurrencyMarkers;
    if (isGuardField(path)) return RECEIPT_PARSER_LIMITS.maxLineGuards;
    if (/^items\.record\[\d+\]\.line$/.test(path)) return RECEIPT_PARSER_LIMITS.maxStepAlternatives;
    if (path === 'items.skipLines') return RECEIPT_PARSER_LIMITS.maxSkipLines;
    if (path === 'items.record') return RECEIPT_PARSER_LIMITS.maxRecordSteps;
    if (path === 'link.fromDomains') return RECEIPT_PARSER_LIMITS.maxFromDomains;
    return RECEIPT_PARSER_LIMITS.maxPatternsPerField;
  }
  if (code === 'too_many_lines') return RECEIPT_PARSER_LIMITS.maxPatternLines;
  if (code === 'link_days_invalid') return RECEIPT_PARSER_LIMITS.maxLinkDaysBefore;
  if (code === 'link_domain_invalid') return RECEIPT_PARSER_LIMITS.maxFromDomains;
  if (code === 'out_of_range') {
    if (path === 'match.daysBefore') return RECEIPT_PARSER_LIMITS.maxDaysBefore;
    if (path === 'match.daysAfter') return RECEIPT_PARSER_LIMITS.maxDaysAfter;
    if (path === 'match.amountTolerance') return RECEIPT_PARSER_LIMITS.maxAmountTolerance;
    return RECEIPT_PARSER_LIMITS.maxLabelWithin;
  }
  if (path === 'tag') return RECEIPT_PARSER_LIMITS.maxTagLength;
  if (path === 'match.by') return RECEIPT_PARSER_LIMITS.maxMatchStrategies;
  return path.endsWith('startAfter') || path.endsWith('stopAt')
    ? RECEIPT_PARSER_LIMITS.maxSectionMarkerLength
    : RECEIPT_PARSER_LIMITS.maxPatternLength;
}

/** The server's closed list (`PARSER_VALIDATION_CODES`), each with a wording below. */
const KNOWN_CODES: ReadonlySet<string> = new Set(PARSER_VALIDATION_CODES);

/** The wording key of a code at a path: the `match` section's range errors are not "1 to 10". */
function codeKey(code: string, path: string): string {
  if (code === 'out_of_range' && (path === 'match.daysBefore' || path === 'match.daysAfter')) return 'out_of_range_days';
  if (code === 'out_of_range' && path === 'match.amountTolerance') return 'out_of_range_tolerance';
  // An id a trade profile holds is an account's, not a category's.
  if (code === 'invalid_uuid' && /(^|\.)(accountId|defaultAccountId)$/.test(path)) return 'invalid_uuid_account';
  return code;
}

interface ParserProblemsProps {
  /** The problems the server's validator listed. */
  problems: readonly ReceiptParserValidationError[];
}

/**
 * The validator's `path: code` problems as a list a person can act on, each
 * with where it is and what is wrong. The codes come from the server's closed
 * list; one this client has not heard of falls back to the raw code rather than
 * hiding that something was refused.
 */
export function ParserProblems({ problems }: ParserProblemsProps) {
  const t = useTranslations('emailReceipts.problems');

  return (
    <div role="alert" className="rounded-lg border border-red-200 bg-red-50 p-3 dark:border-red-900/60 dark:bg-red-900/20">
      <p className="text-sm font-semibold text-red-800 dark:text-red-200">{t('heading')}</p>
      <ul className="mt-1 list-disc space-y-1 pl-5 text-sm text-red-700 dark:text-red-300">
        {problems.map((problem, index) => (
          <li key={`${problem.path}-${problem.code}-${index}`}>
            {t('item', {
              where: describeProblemPath(problem.path, t),
              problem: KNOWN_CODES.has(problem.code)
                ? t(`codes.${codeKey(problem.code, problem.path)}`, {
                    max: boundFor(problem.code, problem.path),
                    capture: '{name}',
                  })
                : problem.code,
            })}
          </li>
        ))}
      </ul>
    </div>
  );
}
