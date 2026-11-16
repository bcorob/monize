import { describe, expect, it } from 'vitest';
import { MAX_RULE_CONDITION_DEPTH, MAX_RULE_CONDITION_LEAVES, RULE_CONDITION_FIELDS } from './rule-fields';
import {
  addChild,
  canDuplicateNode,
  canMoveNode,
  canNestGroup,
  changeLeafField,
  changeLeafOperator,
  cloneNode,
  createGroup,
  createLeaf,
  defaultValue,
  duplicateNode,
  getNode,
  moveNode,
  removeNode,
  treeCapacity,
  treeStats,
  updateNode,
  type EditorGroup,
  type EditorLeaf,
} from './rule-tree';

const leaf = (
  field: EditorLeaf['field'] = 'referenceNumber',
  extra: Partial<EditorLeaf> = {},
): EditorLeaf => ({
  ...createLeaf(field),
  ...extra,
});

function tree(): EditorGroup {
  // root: [a, group(any): [b, c], d]
  const a = leaf('referenceNumber', { value: 'a' });
  const b = leaf('referenceNumber', { value: 'b' });
  const c = leaf('referenceNumber', { value: 'c' });
  const d = leaf('referenceNumber', { value: 'd' });
  return createGroup('all', [a, createGroup('any', [b, c]), d]);
}

const valueAt = (root: EditorGroup, path: number[]) => (getNode(root, path) as EditorLeaf).value;

describe('createLeaf and defaults', () => {
  it('starts on the first operator the field allows, with a value that fits it', () => {
    for (const [field, spec] of Object.entries(RULE_CONDITION_FIELDS)) {
      const made = createLeaf(field as EditorLeaf['field']);
      expect(made.op).toBe(spec.operators[0]);
      expect(made.value).toEqual(defaultValue(made.field, made.op));
    }
  });

  it('defaults an enum to its first value, a boolean to true, a list to empty and a range to two gaps', () => {
    expect(createLeaf('type').value).toBe('EXPENSE');
    expect(createLeaf('hasSplits').value).toBe(true);
    expect(createLeaf('tagIds').value).toEqual([]);
    expect(defaultValue('amount', 'between')).toEqual([undefined, undefined]);
    expect(defaultValue('referenceNumber', 'isEmpty')).toBeUndefined();
    expect(defaultValue('amount', 'eq')).toBeUndefined();
    expect(defaultValue('referenceNumber', 'eq')).toBe('');
  });
});

describe('changing a leaf', () => {
  it('resets the operator and the value when the field changes', () => {
    const before = leaf('amount', { op: 'between', value: [1, 2] });
    const after = changeLeafField(before, 'referenceNumber');
    expect(after).toMatchObject({ field: 'referenceNumber', op: 'eq', value: '', uid: before.uid });
  });

  it('returns the same leaf when the field is unchanged', () => {
    const before = leaf('referenceNumber');
    expect(changeLeafField(before, 'referenceNumber')).toBe(before);
    expect(changeLeafOperator(before, before.op)).toBe(before);
  });

  it('keeps the value across operators of the same shape', () => {
    const before = leaf('referenceNumber', { op: 'contains', value: 'coffee' });
    expect(changeLeafOperator(before, 'startsWith').value).toBe('coffee');
  });

  it('carries a pick from one value to a list and back', () => {
    const one = leaf('payeeId', { value: 'p1' });
    const many = changeLeafOperator(one, 'in');
    expect(many.value).toEqual(['p1']);
    expect(changeLeafOperator(many, 'eq').value).toBe('p1');
  });

  it('carries an amount into a range and back, and starts over across other shapes', () => {
    const one = leaf('amount', { op: 'eq', value: 5 });
    const range = changeLeafOperator(one, 'between');
    expect(range.value).toEqual([5, undefined]);
    expect(changeLeafOperator(range, 'gt').value).toBe(5);
    expect(changeLeafOperator(leaf('referenceNumber', { value: 'x' }), 'isEmpty').value).toBeUndefined();
    expect(changeLeafOperator(leaf('payeeId', { value: '' }), 'in').value).toEqual([]);
    expect(changeLeafOperator(leaf('tagIds', { op: 'hasAny', value: ['t'] }), 'hasAll').value).toEqual(['t']);
  });
});

describe('reading and counting', () => {
  it('finds nodes by path and answers undefined off the tree', () => {
    const root = tree();
    expect(getNode(root, [])).toBe(root);
    expect(valueAt(root, [1, 1])).toBe('c');
    expect(getNode(root, [0, 0])).toBeUndefined();
    expect(getNode(root, [9])).toBeUndefined();
  });

  it('counts leaves and nodes, and reports room', () => {
    const root = tree();
    expect(treeStats(root)).toEqual({ leaves: 4, nodes: 6 });
    expect(treeCapacity(root)).toEqual({ canAddLeaf: true, canAddGroupNode: true });
    const many = createGroup(
      'all',
      Array.from({ length: MAX_RULE_CONDITION_LEAVES }, () => leaf()),
    );
    expect(treeCapacity(many)).toEqual({ canAddLeaf: false, canAddGroupNode: true });
    const nodes = createGroup(
      'all',
      Array.from({ length: 99 }, () => createGroup('any')),
    );
    expect(treeCapacity(nodes)).toEqual({ canAddLeaf: false, canAddGroupNode: false });
  });

  it('allows a group below the root until the depth limit', () => {
    let path: number[] = [];
    for (let depth = 1; depth < MAX_RULE_CONDITION_DEPTH; depth += 1) {
      expect(canNestGroup(path)).toBe(true);
      path = [...path, 0];
    }
    expect(path.length + 1).toBe(MAX_RULE_CONDITION_DEPTH);
    expect(canNestGroup(path)).toBe(false);
  });
});

describe('immutable edits', () => {
  it('replaces a node without touching the original or its siblings', () => {
    const root = tree();
    const next = updateNode(root, [1, 0], (n) => ({ ...(n as EditorLeaf), value: 'B' }));
    expect(valueAt(next, [1, 0])).toBe('B');
    expect(valueAt(root, [1, 0])).toBe('b');
    expect(next.children[0]).toBe(root.children[0]);
    expect(next.children[2]).toBe(root.children[2]);
  });

  it('replaces the root itself with a group, and ignores a root replaced by a leaf', () => {
    const root = tree();
    const negated = updateNode(root, [], (n) => ({ ...(n as EditorGroup), not: true }));
    expect(negated.not).toBe(true);
    expect(updateNode(root, [], () => leaf())).toBe(root);
  });

  it('leaves the tree alone for a path that does not exist or runs through a leaf', () => {
    const root = tree();
    expect(updateNode(root, [9], (n) => n)).toBe(root);
    expect(updateNode(root, [0, 0], (n) => ({ ...n }))).toBe(root);
    expect(removeNode(root, [7])).toBe(root);
  });

  it('adds a child to the group at a path, and only to a group', () => {
    const root = tree();
    const added = leaf('referenceNumber', { value: 'z' });
    const next = addChild(root, [1], added);
    expect((getNode(next, [1]) as EditorGroup).children).toHaveLength(3);
    expect(valueAt(next, [1, 2])).toBe('z');
    expect(addChild(root, [0], added)).toBe(root);
    expect(addChild(root, [], added).children).toHaveLength(4);
  });

  it('removes a node, never the root', () => {
    const root = tree();
    expect(removeNode(root, [0]).children).toHaveLength(2);
    expect((getNode(removeNode(root, [1, 0]), [1]) as EditorGroup).children).toHaveLength(1);
    expect(removeNode(root, [])).toBe(root);
  });

  it('moves a node among its siblings and stops at the ends', () => {
    const root = tree();
    expect(canMoveNode(root, [0], -1)).toBe(false);
    expect(canMoveNode(root, [2], 1)).toBe(false);
    expect(canMoveNode(root, [], 1)).toBe(false);
    expect(canMoveNode(root, [0, 0], 1)).toBe(false);
    expect(moveNode(root, [0], -1)).toBe(root);
    const down = moveNode(root, [0], 1);
    expect(valueAt(down, [1])).toBe('a');
    expect(getNode(down, [0])?.kind).toBe('group');
    const up = moveNode(root, [1, 1], -1);
    expect(valueAt(up, [1, 0])).toBe('c');
    expect(valueAt(root, [1, 0])).toBe('b');
  });

  it('duplicates a node right after itself with fresh identities all the way down', () => {
    const root = tree();
    const next = duplicateNode(root, [1]);
    expect(next.children).toHaveLength(4);
    const original = next.children[1] as EditorGroup;
    const copy = next.children[2] as EditorGroup;
    expect(copy.uid).not.toBe(original.uid);
    expect(copy.children.map((c) => c.uid)).not.toEqual(original.children.map((c) => c.uid));
    expect(copy.children.map((c) => (c as EditorLeaf).value)).toEqual(['b', 'c']);
    expect(duplicateNode(root, [])).toBe(root);
  });

  it('clones a leaf with a new identity', () => {
    const original = leaf();
    expect(cloneNode(original)).toMatchObject({ field: original.field });
    expect(cloneNode(original).uid).not.toBe(original.uid);
  });

  it('refuses a duplicate that would break a limit', () => {
    const root = tree();
    expect(canDuplicateNode(root, [0])).toBe(true);
    expect(canDuplicateNode(root, [])).toBe(false);
    expect(canDuplicateNode(root, [9])).toBe(false);
    const full = createGroup(
      'all',
      Array.from({ length: MAX_RULE_CONDITION_LEAVES }, () => leaf()),
    );
    expect(canDuplicateNode(full, [0])).toBe(false);
    // A group at the deepest level is a copy at the same depth: allowed.
    let deep = createGroup('all', [leaf()]);
    for (let level = 1; level < MAX_RULE_CONDITION_DEPTH - 1; level += 1) deep = createGroup('all', [deep]);
    const path = Array.from({ length: MAX_RULE_CONDITION_DEPTH - 2 }, () => 0);
    const top = createGroup('all', [deep]);
    expect(canDuplicateNode(top, [0])).toBe(true);
    expect(getNode(top, path)?.kind).toBe('group');
  });
});

describe('changing the operator of a day of the month', () => {
  const day = (op: 'eq' | 'in' | 'between', value: never) => ({ ...createLeaf('dayOfMonth'), op, value });

  it('carries one day into a list and back, and into a range as its first end', () => {
    expect(changeLeafOperator(day('eq', 15 as never), 'in').value).toEqual([15]);
    expect(changeLeafOperator(day('in', [3, 9] as never), 'eq').value).toBe(3);
    expect(changeLeafOperator(day('eq', 15 as never), 'between').value).toEqual([15, undefined]);
  });

  it('starts empty when there is nothing to carry', () => {
    expect(changeLeafOperator(day('eq', undefined as never), 'in').value).toEqual([]);
    expect(changeLeafOperator(day('in', [] as never), 'eq').value).toBeUndefined();
  });

  it('defaults a weekday to Monday, a status to the first status and an attachment to yes', () => {
    expect(createLeaf('weekday').value).toBe('MON');
    expect(createLeaf('status').value).toBe('UNRECONCILED');
    expect(createLeaf('hasAttachment').value).toBe(true);
    expect(createLeaf('dayOfMonth').value).toBeUndefined();
  });
});
