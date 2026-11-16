import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { RULE_SKIP_REASONS } from '@/types/transaction-rule-run';
import * as mirror from './rule-fields';

/**
 * The editor's field and operator table is a copy of the backend's, and the
 * server is the authority: an operator the editor offers that the validator
 * refuses is a card that can never be saved, and a field the editor lacks is a
 * stored rule it cannot open. So the backend source is read here and the two
 * are compared, key for key.
 *
 * The three type files import nothing, so they are transpiled and run. The
 * validator imports the UUID regex from elsewhere, so its constants and its
 * code list are read from the text instead.
 */
const backendRules = join(__dirname, '..', '..', '..', 'backend', 'src', 'transaction-rules');

function read(file: string): string {
  return readFileSync(join(backendRules, file), 'utf8');
}

function evaluate(file: string): Record<string, unknown> {
  const { outputText } = ts.transpileModule(read(file), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  });
  const commonjs = { exports: {} as Record<string, unknown> };
  vm.runInNewContext(outputText, { module: commonjs, exports: commonjs.exports });
  return commonjs.exports;
}

/** Values built in another realm; a JSON round trip makes them comparable. */
const plain = (value: unknown): unknown => JSON.parse(JSON.stringify(value));

/** `export const NAME = 12;` for every numeric constant in a source text. */
function numericConstants(source: string): Record<string, number> {
  const found: Record<string, number> = {};
  for (const match of source.matchAll(/^export const ([A-Z_]+) = (\d+);/gm)) {
    found[match[1]] = Number(match[2]);
  }
  return found;
}

describe('the rule editor tables against the backend', () => {
  const conditions = evaluate('rule-condition.types.ts');

  it('offers exactly the backend fields, kinds, operators and enum values', () => {
    expect(plain(mirror.RULE_CONDITION_FIELDS)).toEqual(plain(conditions.RULE_CONDITION_FIELDS));
  });

  it('lists the fields in the backend order', () => {
    expect(mirror.RULE_FIELDS).toEqual(conditions.RULE_FIELDS);
  });

  it('knows every operator and its value shape', () => {
    expect([...mirror.RULE_OPERATORS]).toEqual(conditions.RULE_OPERATORS);
    expect(plain(mirror.RULE_OPERATOR_SHAPES)).toEqual(plain(conditions.RULE_OPERATOR_SHAPES));
  });

  it('has the same transaction types, action types and triggers', () => {
    expect([...mirror.RULE_TRANSACTION_TYPES]).toEqual(conditions.RULE_TRANSACTION_TYPES);
    expect([...mirror.RULE_ACTION_TYPES]).toEqual(evaluate('rule-action.types.ts').RULE_ACTION_TYPES);
    expect([...mirror.RULE_TRIGGERS]).toEqual(evaluate('rule-trigger.types.ts').RULE_TRIGGERS);
  });

  it('gives every operator of every field a shape', () => {
    for (const spec of Object.values(mirror.RULE_CONDITION_FIELDS)) {
      for (const op of spec.operators) expect(mirror.RULE_OPERATOR_SHAPES[op]).toBeDefined();
    }
  });

  it('carries every numeric limit of the validator and the DTO with the same value', () => {
    const backend = {
      ...numericConstants(read('rule-validation.ts')),
      ...numericConstants(read('dto/create-transaction-rule.dto.ts')),
    };
    // A silent miss (a renamed export, a changed pattern) must not read as a pass.
    expect(Object.keys(backend).length).toBeGreaterThanOrEqual(13);
    const mirrored = mirror as unknown as Record<string, unknown>;
    for (const [name, value] of Object.entries(backend)) {
      expect(mirrored[name], name).toBe(value);
    }
  });

  it('names the loan settlement, its policies and its window limit as the backend does', () => {
    const actions = evaluate('rule-action.types.ts');
    expect(mirror.SETTLE_LOAN_INSTALLMENT).toBe(actions.SETTLE_LOAN_INSTALLMENT);
    expect([...mirror.LOAN_SETTLEMENT_EXCESS_POLICIES]).toEqual(actions.LOAN_SETTLEMENT_EXCESS_POLICIES);
    expect([...mirror.LOAN_SETTLEMENT_SHORTFALL_POLICIES]).toEqual(actions.LOAN_SETTLEMENT_SHORTFALL_POLICIES);
    // The editor offers the action beside the mirrored list, as the server accepts it.
    expect([...mirror.ACCEPTED_RULE_ACTION_TYPES]).toEqual([
      ...(actions.RULE_ACTION_TYPES as string[]),
      actions.SETTLE_LOAN_INSTALLMENT,
    ]);
    expect(mirror.MAX_LOAN_SETTLEMENT_WINDOW_DAYS).toBe(
      numericConstants(read('transaction-rules.limits.ts')).MAX_LOAN_SETTLEMENT_WINDOW_DAYS,
    );
  });

  it('words every skip reason and every missing loan input the backend can answer with', () => {
    // A union is not a value, so its string literals are read from the text.
    const literals = (source: string, name: string): string[] => {
      const block = new RegExp(`type ${name} =([\\s\\S]*?);`).exec(source);
      expect(block, name).not.toBeNull();
      return [...block![1].matchAll(/"([a-z_A-Z]+)"/g)].map((m) => m[1]);
    };
    const structure = read('rule-structure.ts');
    const reasons = [
      ...literals(read('rule-run.types.ts'), 'RuleRunSkipReason'),
      ...literals(structure, 'StructuralRefusal'),
      ...literals(structure, 'LoanSettlementSkipReason'),
    ];
    expect(reasons.length).toBeGreaterThan(25);
    expect([...RULE_SKIP_REASONS].sort()).toEqual([...new Set(reasons)].sort());

    const core = readFileSync(join(backendRules, '..', 'loan-installments', 'loan-settlement.types.ts'), 'utf8');
    expect([...mirror.LOAN_SETTLEMENT_MISSING_INPUTS].sort()).toEqual(
      literals(core, 'LoanSettlementMissingInput').sort(),
    );
  });

  it('lists the same validation codes in the same order', () => {
    const source = read('rule-validation.ts');
    const block = /RULE_VALIDATION_CODES = \[([\s\S]*?)\] as const/.exec(source);
    expect(block).not.toBeNull();
    const codes = [...block![1].matchAll(/"([A-Z_]+)"/g)].map((m) => m[1]);
    expect(codes.length).toBeGreaterThan(10);
    expect([...mirror.RULE_VALIDATION_CODES]).toEqual(codes);
  });
});
