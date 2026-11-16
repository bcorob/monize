import { describe, expect, it } from 'vitest';
import { EntityIndex, parseCondition, printCondition } from '@/lib/rule-cel';
import { conditionToApi } from '@/lib/rule-draft';
import { RULE_CONDITION_FIELDS, RULE_FIELDS, RULE_OPERATOR_SHAPES } from '@/lib/rule-fields';
import { defaultValue, treeStats, type EditorGroup } from '@/lib/rule-tree';
import { INDEX, group, leaf, leafFor, randomTree, seeded, stripUids } from '@/test/rule-cel-support';

function trip(tree: EditorGroup, index: EntityIndex = INDEX): { text: string; back: EditorGroup } {
  const text = printCondition(tree, index);
  const result = parseCondition(text, index);
  if (!result.ok) throw new Error(`${text}\n${result.error.key} at ${result.error.position}`);
  return { text, back: result.root };
}

const expectTrip = (tree: EditorGroup) => {
  const { text, back } = trip(tree);
  expect(stripUids(back), text).toEqual(stripUids(tree));
  // A second trip is stable: the text is canonical.
  expect(printCondition(back, INDEX)).toBe(text);
};

describe('parse(print(tree)) is the tree', () => {
  it('holds for every operator of every field, alone', () => {
    let seen = 0;
    const rand = seeded(7);
    for (const field of RULE_FIELDS) {
      for (const op of RULE_CONDITION_FIELDS[field].operators) {
        expectTrip(group('all', [leaf(field, op, defaultValue(field, op))]));
        for (let i = 0; i < 12; i += 1) {
          expectTrip(group('all', [leafFor(rand, field, op)]));
          seen += 1;
        }
      }
    }
    expect(seen).toBeGreaterThan(200);
  });

  it('holds for a leaf of each operator shape with concrete values', () => {
    const cases = [
      leaf('payeeText', 'eq', ''),
      leaf('payeeText', 'contains', 'has "quotes", \\ and\nlines'),
      leaf('amount', 'between', [-500, -100]),
      leaf('amount', 'between', [undefined, undefined]),
      leaf('type', 'in', []),
      leaf('accountId', 'in', ['acc-1', 'acc-3', 'gone']),
      leaf('tagIds', 'hasAll', ['tag-3']),
      leaf('categoryId', 'inSubtree', ''),
      leaf('hasSplits', 'eq', true),
      leaf('currencyCode', 'in', ['cad', 'USD']),
    ];
    for (const one of cases) expectTrip(group('all', [one]));
  });

  it('holds for every shape of group the editor can make', () => {
    const a = leaf('referenceNumber', 'contains', 'a');
    const b = leaf('accountId', 'in', ['acc-2']);
    const shapes: EditorGroup[] = [
      group('all'),
      group('any'),
      group('all', [], true),
      group('any', [], true),
      group('all', [a]),
      group('any', [a]),
      group('all', [a], true),
      group('any', [a], true),
      group('all', [b], true),
      group('all', [a, b]),
      group('any', [a, b], true),
      group('all', [group('all')]),
      group('all', [group('any')]),
      group('any', [group('all', [a])]),
      group('all', [group('all', [a], true)]),
      group('all', [group('all', [a, b])], true),
      group('all', [group('any', [a, b])]),
      group('any', [a, group('all', [a, b]), group('any', [b], true), group('all')]),
      group('all', [group('all', [group('all', [group('all', [a, b])])])]),
      group('all', [group('any', [group('all', [group('any', [a, b, a], true)], true)], true)], true),
    ];
    for (const tree of shapes) expectTrip(tree);
  });

  it('holds for hundreds of random trees inside the limits', () => {
    const rand = seeded(20260929);
    let groups = 0;
    let leaves = 0;
    for (let i = 0; i < 600; i += 1) {
      const tree = randomTree(rand);
      const stats = treeStats(tree);
      groups += stats.nodes - stats.leaves;
      leaves += stats.leaves;
      expectTrip(tree);
    }
    expect(leaves).toBeGreaterThan(1500);
    expect(groups).toBeGreaterThan(800);
  });

  it('yields the same stored condition, which is what is saved', () => {
    const rand = seeded(99);
    for (let i = 0; i < 100; i += 1) {
      const tree = randomTree(rand);
      expect(conditionToApi(trip(tree).back)).toEqual(conditionToApi(tree));
    }
  });

  it('holds with no catalog at all: every item is then a missing() reference', () => {
    const empty = new EntityIndex();
    const tree = group('all', [leaf('accountId', 'eq', 'x'), leaf('tagIds', 'hasAny', ['a', 'b'])]);
    const { text, back } = trip(tree, empty);
    expect(text).toContain('missing("x")');
    expect(stripUids(back)).toEqual(stripUids(tree));
  });

  it('holds when the same name is shared by several items of every kind', () => {
    const shared = new EntityIndex({
      account: [{ id: 'b', name: 'X' }, { id: 'a', name: 'X' }],
      payee: [{ id: 'p2', name: 'X' }, { id: 'p1', name: 'X' }, { id: 'p3', name: 'X' }],
      category: [{ id: 'c1', name: 'X' }, { id: 'c2', name: 'X' }],
      tag: [{ id: 't1', name: 'X' }, { id: 't2', name: 'X' }],
    });
    const tree = group('all', [
      leaf('accountId', 'in', ['a', 'b']),
      leaf('payeeId', 'eq', 'p3'),
      leaf('categoryId', 'inSubtree', 'c2'),
      leaf('tagIds', 'hasNone', ['t2', 't1']),
    ]);
    const { text, back } = trip(tree, shared);
    expect(text).toContain('account("X", 1), account("X", 2)');
    expect(stripUids(back)).toEqual(stripUids(tree));
  });

  it('uses the operator table: nothing printed is refused for its operator', () => {
    for (const field of RULE_FIELDS) {
      for (const op of RULE_CONDITION_FIELDS[field].operators) {
        expect(RULE_OPERATOR_SHAPES[op]).toBeDefined();
        const text = printCondition(group('all', [leaf(field, op, defaultValue(field, op))]), INDEX);
        const result = parseCondition(text, INDEX);
        expect(result.ok, text).toBe(true);
      }
    }
  });
});
