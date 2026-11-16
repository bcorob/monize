import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useRouter } from 'next/navigation';
import { render, screen, fireEvent, within } from '@/test/render';
import { RulesList, type RulesListProps } from './RulesList';
import { makeRule } from './rules-test-fixtures';

const handlers = {
  onToggle: vi.fn(),
  onDuplicate: vi.fn(),
  onRun: vi.fn(),
  onMove: vi.fn(),
  onDelete: vi.fn(),
};

function renderList(overrides: Partial<RulesListProps> = {}) {
  return render(
    <RulesList
      rules={[
        makeRule({ id: 'a', name: 'Coffee shops' }),
        makeRule({ id: 'b', name: 'Salary', enabled: false, triggers: ['create', 'import'] }),
      ]}
      pendingIds={new Set()}
      reordering={false}
      {...handlers}
      {...overrides}
    />,
  );
}

function rowOf(name: string): HTMLElement {
  return screen.getByText(name).closest('tr') as HTMLElement;
}

function openMenu(name: string) {
  fireEvent.click(within(rowOf(name)).getByRole('button', { name: 'More actions' }));
}

describe('RulesList', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shows each rule in order with its one-line summary', () => {
    renderList();
    const names = screen.getAllByRole('row').slice(1).map((r) => within(r).getAllByRole('cell')[2]);
    expect(names[0]).toHaveTextContent('Coffee shops');
    expect(names[1]).toHaveTextContent('Salary');
    expect(within(rowOf('Coffee shops')).getAllByText('When created · 1 condition · 2 actions').length).toBeGreaterThan(0);
    expect(within(rowOf('Salary')).getAllByText(/When created or imported/).length).toBeGreaterThan(0);
  });

  it('reflects the enabled state in the switch and reports a change', () => {
    renderList();
    const on = within(rowOf('Coffee shops')).getByRole('switch', { name: 'Enable Coffee shops' });
    const off = within(rowOf('Salary')).getByRole('switch', { name: 'Enable Salary' });
    expect(on).toHaveAttribute('aria-checked', 'true');
    expect(off).toHaveAttribute('aria-checked', 'false');
    fireEvent.click(on);
    expect(handlers.onToggle).toHaveBeenCalledWith(expect.objectContaining({ id: 'a' }), false);
  });

  it('disables the switch of a rule with a change in flight', () => {
    renderList({ pendingIds: new Set(['a']) });
    expect(within(rowOf('Coffee shops')).getByRole('switch')).toBeDisabled();
    expect(within(rowOf('Salary')).getByRole('switch')).toBeEnabled();
  });

  it('opens the editor route on a row click, not on a click inside the switch', () => {
    const router = useRouter();
    renderList();
    fireEvent.click(within(rowOf('Coffee shops')).getByRole('switch'));
    expect(router.push).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText('Coffee shops'));
    expect(router.push).toHaveBeenCalledWith('/rules/a');
  });

  it('opens the editor route from the keyboard', () => {
    const router = useRouter();
    renderList();
    fireEvent.keyDown(rowOf('Salary'), { key: 'Enter' });
    expect(router.push).toHaveBeenCalledWith('/rules/b');
  });

  it('does not open the row when Enter is pressed on the switch', () => {
    const router = useRouter();
    renderList();
    fireEvent.keyDown(within(rowOf('Salary')).getByRole('switch'), { key: 'Enter' });
    expect(router.push).not.toHaveBeenCalled();
  });

  it('offers edit inline and the rest in the menu', () => {
    const router = useRouter();
    renderList();
    fireEvent.click(within(rowOf('Coffee shops')).getByRole('button', { name: 'Edit' }));
    expect(router.push).toHaveBeenCalledWith('/rules/a');

    openMenu('Coffee shops');
    const items = screen.getAllByRole('menuitem').map((i) => i.textContent);
    expect(items).toEqual(['Duplicate', 'Run on existing transactions', 'Move up', 'Move down', 'Delete']);
  });

  it('disables move up on the first rule and move down on the last', () => {
    renderList();
    openMenu('Coffee shops');
    expect(screen.getByRole('menuitem', { name: 'Move up' })).toBeDisabled();
    expect(screen.getByRole('menuitem', { name: 'Move down' })).toBeEnabled();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Move down' }));
    expect(handlers.onMove).toHaveBeenCalledWith(expect.objectContaining({ id: 'a' }), 'down');

    openMenu('Salary');
    expect(screen.getByRole('menuitem', { name: 'Move down' })).toBeDisabled();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Move up' }));
    expect(handlers.onMove).toHaveBeenCalledWith(expect.objectContaining({ id: 'b' }), 'up');
  });

  it('disables every move while a reorder is in flight', () => {
    renderList({ reordering: true });
    openMenu('Salary');
    expect(screen.getByRole('menuitem', { name: 'Move up' })).toBeDisabled();
  });

  it('reports the run on existing transactions', () => {
    renderList();
    openMenu('Salary');
    fireEvent.click(screen.getByRole('menuitem', { name: 'Run on existing transactions' }));
    expect(handlers.onRun).toHaveBeenCalledWith(expect.objectContaining({ id: 'b' }));
  });

  it('will not run an invalid rule', () => {
    renderList({
      rules: [makeRule({ id: 'a', name: 'Broken', invalid: true, invalidReasons: [{ path: 'actions', code: 'NO_ACTIONS' }] })],
    });
    openMenu('Broken');
    expect(screen.getByRole('menuitem', { name: 'Run on existing transactions' })).toBeDisabled();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Run on existing transactions' }));
    expect(handlers.onRun).not.toHaveBeenCalled();
  });

  it('reports duplicate and delete', () => {
    renderList();
    openMenu('Salary');
    fireEvent.click(screen.getByRole('menuitem', { name: 'Duplicate' }));
    expect(handlers.onDuplicate).toHaveBeenCalledWith(expect.objectContaining({ id: 'b' }));
    openMenu('Salary');
    fireEvent.click(screen.getByRole('menuitem', { name: 'Delete' }));
    expect(handlers.onDelete).toHaveBeenCalledWith(expect.objectContaining({ id: 'b' }));
  });

  it('marks an invalid rule and lists why in the tooltip', () => {
    renderList({
      rules: [
        makeRule({
          id: 'x',
          name: 'Broken',
          invalid: true,
          invalidReasons: [
            { path: 'actions[0]', code: 'REFERENCE_NOT_FOUND' },
            { path: 'actions', code: 'DUPLICATE_ACTION' },
          ],
        }),
        makeRule({ id: 'y', name: 'Fine' }),
      ],
    });
    expect(within(rowOf('Broken')).getByText('Invalid')).toBeInTheDocument();
    expect(
      within(rowOf('Broken')).getByLabelText(
        'Skipped until fixed: a tag, payee, category or account it uses no longer exists and it repeats an action that is allowed only once.',
      ),
    ).toBeInTheDocument();
    expect(within(rowOf('Fine')).queryByText('Invalid')).not.toBeInTheDocument();
  });

  it('opens on a rule whose stored definition is unreadable', () => {
    renderList({
      rules: [
        makeRule({
          id: 'x',
          name: 'Restored',
          invalid: true,
          triggers: [],
          condition: {} as never,
          actions: [],
          invalidReasons: [{ path: 'condition', code: 'INVALID_SHAPE' }],
        }),
      ],
    });
    expect(within(rowOf('Restored')).getAllByText('No trigger · No conditions · No actions').length).toBeGreaterThan(0);
  });

  it('opens the action sheet on a context menu press and acts on the current rule', () => {
    renderList();
    fireEvent.contextMenu(rowOf('Salary'));
    const sheet = screen.getByRole('dialog');
    expect(within(sheet).getByText('Salary')).toBeInTheDocument();
    fireEvent.click(within(sheet).getByRole('button', { name: /Delete/ }));
    expect(handlers.onDelete).toHaveBeenCalledWith(expect.objectContaining({ id: 'b' }));
  });
});
