import { describe, expect, it } from 'vitest';
import en from '@/i18n/messages/en/rules.json';
import common from '@/i18n/messages/en/common.json';
import transactions from '@/i18n/messages/en/transactions.json';
import { DESCRIPTION_MODES } from '@/lib/rule-actions';
import { CEL_ERROR_KEYS, EntityIndex, complete } from '@/lib/rule-cel';
import { RULE_SKIP_REASONS } from '@/types/transaction-rule-run';
import {
  EDITOR_RULE_FIELDS,
  ACCEPTED_RULE_ACTION_TYPES,
  LOAN_SETTLEMENT_EXCESS_POLICIES,
  LOAN_SETTLEMENT_MISSING_INPUTS,
  LOAN_SETTLEMENT_SHORTFALL_POLICIES,
  RULE_CONDITION_FIELDS,
  RULE_FIELDS,
  RULE_OPERATORS,
  RULE_TRANSACTION_TYPES,
  RULE_VALIDATION_CODES,
} from '@/lib/rule-fields';

/**
 * The editor builds keys from the tables (`fields.${field}`, `operators.${op}`,
 * and so on), so a value added to a table without a sentence would render as a
 * raw key. The harness turns that into a failure only where a test happens to
 * draw it; this pins the whole set.
 */
const editor = en.editor as unknown as Record<string, Record<string, unknown>>;

describe('the rule editor catalog', () => {
  it.each([
    ['fields', EDITOR_RULE_FIELDS],
    ['operators', RULE_OPERATORS],
    ['types', RULE_TRANSACTION_TYPES],
    ['actionTypes', ACCEPTED_RULE_ACTION_TYPES],
  ])('has a label for every entry of %s', (group, keys) => {
    for (const key of keys) expect(typeof editor[group][key], `${group}.${key}`).toBe('string');
  });

  it('has a label for every field, including the five newer ones the editor now draws', () => {
    for (const field of ['referenceNumber', 'dayOfMonth', 'weekday', 'status', 'hasAttachment'] as const) {
      expect(EDITOR_RULE_FIELDS, field).toContain(field);
      expect(typeof editor.fields[field], field).toBe('string');
    }
    expect([...EDITOR_RULE_FIELDS].sort()).toEqual([...RULE_FIELDS].sort());
  });

  it('has a name for every value of the enum fields, from the catalogs that already hold them', () => {
    for (const value of RULE_CONDITION_FIELDS.type.enumValues ?? []) expect(typeof editor.types[value], value).toBe('string');
    const statusLabels = transactions.filter.statusLabels as Record<string, string>;
    for (const value of RULE_CONDITION_FIELDS.status.enumValues ?? []) {
      expect(typeof statusLabels[value.toLowerCase()], value).toBe('string');
    }
    // Sunday first in the catalog; the editor lists Monday first and maps the code onto it.
    expect(common.weekdaysShort).toHaveLength(7);
    expect(RULE_CONDITION_FIELDS.weekday.enumValues).toHaveLength(7);
  });

  it('has a sentence for every way a description is written', () => {
    const modes = (editor.action as Record<string, unknown>).modes as Record<string, unknown>;
    expect(Object.keys(modes).sort()).toEqual([...DESCRIPTION_MODES].sort());
  });

  it('names both settlement policies of each kind, and every action in words', () => {
    const loan = (editor.action as Record<string, Record<string, Record<string, unknown>>>).loan;
    expect(Object.keys(loan.excessPolicies).sort()).toEqual([...LOAN_SETTLEMENT_EXCESS_POLICIES].sort());
    expect(Object.keys(loan.shortfallPolicies).sort()).toEqual([...LOAN_SETTLEMENT_SHORTFALL_POLICIES].sort());
    const words = en.words.action as Record<string, unknown>;
    for (const type of ACCEPTED_RULE_ACTION_TYPES) expect(typeof words[type], type).toBe('string');
  });

  it('has a sentence for every skip reason and every missing loan input', () => {
    const skipReasons = en.run.skipReasons as Record<string, unknown>;
    for (const reason of RULE_SKIP_REASONS) expect(typeof skipReasons[reason], reason).toBe('string');
    expect(Object.keys(skipReasons).sort()).toEqual([...RULE_SKIP_REASONS, 'other'].sort());
    const missing = en.run.missingInputs as Record<string, unknown>;
    expect(Object.keys(missing).sort()).toEqual([...LOAN_SETTLEMENT_MISSING_INPUTS, 'other'].sort());
  });

  it('has a sentence for every validation code, for the reference check, the local name check and an unknown code', () => {
    const codes = editor.errors.codes as Record<string, unknown>;
    for (const code of [...RULE_VALIDATION_CODES, 'REFERENCE_NOT_FOUND', 'NAME_REQUIRED', 'UNKNOWN']) {
      expect(typeof codes[code], code).toBe('string');
    }
  });

  it('has no label without a table entry to draw it', () => {
    expect(Object.keys(editor.fields).sort()).toEqual([...EDITOR_RULE_FIELDS].sort());
    expect(Object.keys(editor.operators).sort()).toEqual([...RULE_OPERATORS].sort());
    expect(Object.keys(editor.actionTypes).sort()).toEqual([...ACCEPTED_RULE_ACTION_TYPES].sort());
    expect(Object.keys(editor.errors.codes as object).sort()).toEqual(
      [...RULE_VALIDATION_CODES, 'REFERENCE_NOT_FOUND', 'NAME_REQUIRED', 'UNKNOWN'].sort(),
    );
  });

  it('has a sentence for every expression error kind, and a label for every suggestion hint', () => {
    const expression = editor.expression as Record<string, Record<string, unknown>>;
    expect(Object.keys(expression.errors).sort()).toEqual([...CEL_ERROR_KEYS].sort());
    for (const key of CEL_ERROR_KEYS) expect(typeof expression.errors[key], key).toBe('string');

    // Every hint autocomplete can attach names a label the catalog has.
    const index = new EntityIndex();
    const hints = new Set<string>();
    for (const field of RULE_FIELDS) {
      for (const text of [`transaction.${field} `, `transaction.${field}.`, `transaction.${field} == `, 'transaction.']) {
        for (const item of complete(text, text.length, index)?.items ?? []) if (item.hint) hints.add(item.hint);
      }
    }
    expect(hints.size).toBeGreaterThan(20);
    for (const hint of hints) {
      const [group, key] = hint.split('.');
      expect(typeof editor[group]?.[key], hint).toBe('string');
    }
  });
});
