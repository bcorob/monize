import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@/test/render';
import { GroupHarness } from './rule-test-harness';
import { MAX_RULE_CONDITION_DEPTH, MAX_RULE_CONDITION_LEAVES } from '@/lib/rule-fields';
import { createGroup, createLeaf, getNode, type EditorGroup, type EditorLeaf } from '@/lib/rule-tree';

Element.prototype.scrollIntoView = vi.fn();

const memo = (value: string): EditorLeaf => ({
  ...createLeaf('referenceNumber'),
  value,
});

/** The memo values of a group's children, `[...]` for a nested group. */
function shape(group: EditorGroup): unknown[] {
  return group.children.map((c) => (c.kind === 'group' ? shape(c) : (c as EditorLeaf).value));
}

function openMenu(cardIndex: number) {
  fireEvent.click(screen.getAllByRole('button', { name: 'More actions' })[cardIndex]);
}
const pick = (name: string) => fireEvent.click(screen.getByRole('menuitem', { name }));

describe('RuleConditionGroup', () => {
  it('adds a condition and a group from its footer', () => {
    const onRoot = vi.fn();
    render(<GroupHarness initial={createGroup('all')} onRoot={onRoot} />);
    expect(screen.queryAllByRole('group', { name: 'Condition' })).toHaveLength(0);

    fireEvent.click(screen.getByRole('button', { name: '+ Add condition' }));
    expect(screen.getAllByRole('group', { name: 'Condition' })).toHaveLength(1);

    fireEvent.click(screen.getByRole('button', { name: '+ Add group' }));
    expect(screen.getAllByRole('group', { name: 'Group' })).toHaveLength(1);
    expect(screen.getByText('This group is empty.')).toBeInTheDocument();
    expect(onRoot).toHaveBeenCalledTimes(2);
  });

  it('adds into the nested group whose footer was used', () => {
    const onRoot = vi.fn();
    render(<GroupHarness initial={createGroup('all', [createGroup('any')])} onRoot={onRoot} />);
    const nested = screen.getByRole('group', { name: 'Group' });
    fireEvent.click(within(nested).getByRole('button', { name: '+ Add condition' }));
    const root = onRoot.mock.calls[0][0] as EditorGroup;
    expect((getNode(root, [0]) as EditorGroup).children).toHaveLength(1);
    expect(root.children).toHaveLength(1);
  });

  it('switches between all and any, and negates the group', () => {
    const onRoot = vi.fn();
    render(<GroupHarness initial={createGroup('all', [memo('a')])} onRoot={onRoot} />);
    expect(screen.getByRole('button', { name: 'All of these' })).toHaveAttribute('aria-pressed', 'true');

    fireEvent.click(screen.getByRole('button', { name: 'Any of these' }));
    expect(onRoot).toHaveBeenLastCalledWith(expect.objectContaining({ match: 'any', not: false }));
    expect(screen.getByRole('button', { name: 'Any of these' })).toHaveAttribute('aria-pressed', 'true');

    // The switch is named beside it, not only for a screen reader.
    const negate = screen.getByRole('switch', { name: 'Negate Group' });
    expect(negate.parentElement).toHaveTextContent('Negate Group');
    fireEvent.click(negate);
    expect(onRoot).toHaveBeenLastCalledWith(expect.objectContaining({ match: 'any', not: true }));
  });

  it('removes a condition from its menu', () => {
    const onRoot = vi.fn();
    render(<GroupHarness initial={createGroup('all', [memo('a'), memo('b')])} onRoot={onRoot} />);
    openMenu(0);
    pick('Delete');
    expect(shape(onRoot.mock.calls[0][0])).toEqual(['b']);
    expect(screen.getAllByRole('group', { name: 'Condition' })).toHaveLength(1);
  });

  it('duplicates and moves a condition from its menu, and disables a move that has nowhere to go', () => {
    const onRoot = vi.fn();
    render(<GroupHarness initial={createGroup('all', [memo('a'), memo('b')])} onRoot={onRoot} />);

    openMenu(0);
    expect(screen.getByRole('menuitem', { name: 'Move up' })).toBeDisabled();
    pick('Move down');
    expect(shape(onRoot.mock.calls[0][0])).toEqual(['b', 'a']);

    openMenu(1);
    expect(screen.getByRole('menuitem', { name: 'Move down' })).toBeDisabled();
    pick('Duplicate');
    expect(shape(onRoot.mock.calls[1][0])).toEqual(['b', 'a', 'a']);
  });

  it('deletes and duplicates a whole nested group', () => {
    const onRoot = vi.fn();
    render(<GroupHarness initial={createGroup('all', [createGroup('any', [memo('x')])])} onRoot={onRoot} />);
    // A card's menu follows its content in the page, so the group's own is after its condition's.
    openMenu(1);
    pick('Duplicate');
    expect(shape(onRoot.mock.calls[0][0])).toEqual([['x'], ['x']]);
    openMenu(1);
    pick('Delete');
    expect(shape(onRoot.mock.calls[1][0])).toEqual([['x']]);
  });

  it('disables Add group at the depth limit and says why', () => {
    let deepest = createGroup('all');
    for (let depth = 1; depth < MAX_RULE_CONDITION_DEPTH; depth += 1) deepest = createGroup('all', [deepest]);
    render(<GroupHarness initial={deepest} />);

    const buttons = screen.getAllByRole('button', { name: '+ Add group' });
    // A group's footer follows its content, so the deepest group's comes first.
    expect(buttons).toHaveLength(MAX_RULE_CONDITION_DEPTH);
    expect(buttons[0]).toBeDisabled();
    expect(buttons.slice(1).every((b) => !(b as HTMLButtonElement).disabled)).toBe(true);
    expect(screen.getByText(`Groups can be nested at most ${MAX_RULE_CONDITION_DEPTH} levels deep.`)).toBeInTheDocument();
  });

  it('cannot nest past the limit by clicking through', () => {
    render(<GroupHarness initial={createGroup('all')} />);
    for (let level = 1; level < MAX_RULE_CONDITION_DEPTH; level += 1) {
      // The innermost group's footer is first in the page.
      fireEvent.click(screen.getAllByRole('button', { name: '+ Add group' })[0]);
    }
    const buttons = screen.getAllByRole('button', { name: '+ Add group' });
    expect(buttons).toHaveLength(MAX_RULE_CONDITION_DEPTH);
    expect(buttons[0]).toBeDisabled();
  });

  it('disables Add condition once the tree holds the most conditions the server allows', () => {
    const full = createGroup(
      'all',
      Array.from({ length: MAX_RULE_CONDITION_LEAVES }, (_, i) => memo(String(i))),
    );
    render(<GroupHarness initial={full} />);
    expect(screen.getByRole('button', { name: '+ Add condition' })).toBeDisabled();
    expect(screen.getByText('The condition limit has been reached.')).toBeInTheDocument();
    // Duplicating would exceed the limit too.
    openMenu(0);
    expect(screen.getByRole('menuitem', { name: 'Duplicate' })).toBeDisabled();
  });

  it('shows the errors of the group and of its cards where the paths point', () => {
    render(
      <GroupHarness
        initial={createGroup('all', [memo('a'), createGroup('any', [memo('b')])])}
        errors={{ 'c:': ['MAX_LEAVES'], 'c:0': ['VALUE_REQUIRED'], 'c:1': ['MAX_DEPTH'], 'c:1.0': ['INVALID_SHAPE'] }}
      />,
    );
    expect(screen.getByText(/There are too many conditions/)).toBeInTheDocument();
    expect(screen.getByText('Enter or choose a value.')).toBeInTheDocument();
    expect(screen.getByText(/Groups are nested too deeply/)).toBeInTheDocument();
    expect(screen.getByText('This part is not in a form the editor understands.')).toBeInTheDocument();
  });

  it('gives an unknown error code a generic sentence instead of a raw key', () => {
    render(<GroupHarness initial={createGroup('all', [memo('a')])} errors={{ 'c:0': ['SOMETHING_NEW'] }} />);
    expect(screen.getByText('This part is not valid.')).toBeInTheDocument();
  });
});
