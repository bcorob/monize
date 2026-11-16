import { describe, it, expect, vi, beforeEach } from 'vitest';
import toast from 'react-hot-toast';
import { AxiosError } from 'axios';
import { render, screen, fireEvent, within, act, waitFor } from '@/test/render';
import { RulesManager } from './RulesManager';
import { makeRule } from './rules-test-fixtures';
import type { TransactionRule } from '@/types/transaction-rule';

const api = vi.hoisted(() => ({
  previewRun: vi.fn(),
  run: vi.fn(),
  getAll: vi.fn(),
  create: vi.fn(),
  setEnabled: vi.fn(),
  reorder: vi.fn(),
  delete: vi.fn(),
}));

vi.mock('@/lib/transaction-rules-api', () => ({ transactionRulesApi: api }));
vi.mock('@/lib/accounts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/accounts')>()),
  accountsApi: { getAll: vi.fn().mockResolvedValue([]) },
}));
vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() }),
}));

const first = makeRule({ id: 'a', name: 'Coffee shops', position: 0 });
const second = makeRule({ id: 'b', name: 'Salary', position: 1, revision: 4 });

async function renderManager() {
  let result!: ReturnType<typeof render>;
  await act(async () => {
    result = render(<RulesManager />);
  });
  return result;
}

function rowOf(name: string): HTMLElement {
  return screen.getByText(name).closest('tr') as HTMLElement;
}

async function pickFromMenu(name: string, item: string) {
  fireEvent.click(within(rowOf(name)).getByRole('button', { name: 'More actions' }));
  await act(async () => {
    fireEvent.click(screen.getByRole('menuitem', { name: item }));
  });
}

/** A refused request with no message of its own, so the caller's fallback shows. */
function failure(): AxiosError {
  return new AxiosError('failed');
}

function conflict(): AxiosError {
  const error = new AxiosError('conflict');
  error.response = {
    status: 409,
    data: { errorCode: 'RULE_LIST_CHANGED', message: 'changed' },
  } as AxiosError['response'];
  return error;
}

describe('RulesManager', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.getAll.mockResolvedValue([first, second]);
  });

  it('lists the rules with the total', async () => {
    await renderManager();
    expect(screen.getByText('Coffee shops')).toBeInTheDocument();
    expect(screen.getByText('Salary')).toBeInTheDocument();
    expect(screen.getByText('2 rules')).toBeInTheDocument();
  });

  it('keeps the tour anchor on the list card in every state, empty included', async () => {
    const { container, unmount } = await renderManager();
    expect(container.querySelectorAll('[data-tour-id="rules-list"]')).toHaveLength(1);
    unmount();
    api.getAll.mockResolvedValue([]);
    const empty = await renderManager();
    expect(empty.container.querySelectorAll('[data-tour-id="rules-list"]')).toHaveLength(1);
    expect(screen.getByText('No rules yet')).toBeInTheDocument();
  });

  it('shows a spinner while the first load is in flight', async () => {
    let resolve!: (rules: TransactionRule[]) => void;
    api.getAll.mockReturnValue(new Promise((r) => (resolve = r)));
    await renderManager();
    expect(screen.getByText('Loading rules...')).toBeInTheDocument();
    await act(async () => resolve([first]));
    expect(screen.queryByText('Loading rules...')).not.toBeInTheDocument();
  });

  it('shows the empty state with a create link when there are no rules', async () => {
    api.getAll.mockResolvedValue([]);
    await renderManager();
    expect(screen.getByText('No rules yet')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Create your first rule' })).toHaveAttribute('href', '/rules/new');
  });

  it('shows an error state, never the empty state, when the load fails, and retries', async () => {
    api.getAll.mockRejectedValueOnce(failure());
    await renderManager();
    expect(screen.getByRole('alert')).toHaveTextContent('Your rules could not be loaded');
    expect(screen.queryByText('No rules yet')).not.toBeInTheDocument();
    expect(toast.error).toHaveBeenCalledWith('Failed to load rules');

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    });
    expect(screen.getByText('Coffee shops')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('keeps the list on screen when a later reload fails', async () => {
    api.reorder.mockRejectedValue(conflict());
    api.getAll.mockResolvedValueOnce([first, second]).mockRejectedValueOnce(failure());
    await renderManager();
    await pickFromMenu('Coffee shops', 'Move down');
    expect(screen.getByText('Coffee shops')).toBeInTheDocument();
    expect(screen.queryByText('No rules yet')).not.toBeInTheDocument();
  });

  it('toggles a rule and adopts the answer', async () => {
    api.setEnabled.mockResolvedValue({ ...first, enabled: false, revision: 2 });
    await renderManager();
    await act(async () => {
      fireEvent.click(within(rowOf('Coffee shops')).getByRole('switch'));
    });
    expect(api.setEnabled).toHaveBeenCalledWith('a', false);
    expect(within(rowOf('Coffee shops')).getByRole('switch')).toHaveAttribute('aria-checked', 'false');
    expect(toast.success).toHaveBeenCalledWith('Rule disabled');
  });

  it('leaves the switch where it was when the toggle fails', async () => {
    api.setEnabled.mockRejectedValue(failure());
    await renderManager();
    await act(async () => {
      fireEvent.click(within(rowOf('Coffee shops')).getByRole('switch'));
    });
    expect(within(rowOf('Coffee shops')).getByRole('switch')).toHaveAttribute('aria-checked', 'true');
    expect(toast.error).toHaveBeenCalledWith('Failed to change the rule');
  });

  it('asks before deleting, and deletes on confirm', async () => {
    api.delete.mockResolvedValue(undefined);
    await renderManager();
    await pickFromMenu('Salary', 'Delete');
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByText('Delete rule')).toBeInTheDocument();
    expect(within(dialog).getByText(/Are you sure you want to delete "Salary"/)).toBeInTheDocument();
    expect(api.delete).not.toHaveBeenCalled();

    await act(async () => {
      fireEvent.click(within(dialog).getByRole('button', { name: 'Delete' }));
    });
    expect(api.delete).toHaveBeenCalledWith('b');
    expect(screen.queryByText('Salary')).not.toBeInTheDocument();
    expect(toast.success).toHaveBeenCalledWith('Rule deleted');
  });

  it('does not delete when the confirmation is cancelled', async () => {
    await renderManager();
    await pickFromMenu('Salary', 'Delete');
    await act(async () => {
      fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Cancel' }));
    });
    expect(api.delete).not.toHaveBeenCalled();
    expect(screen.getByText('Salary')).toBeInTheDocument();
  });

  it('keeps the rule and says so when the delete fails', async () => {
    api.delete.mockRejectedValue(failure());
    await renderManager();
    await pickFromMenu('Salary', 'Delete');
    await act(async () => {
      fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Delete' }));
    });
    expect(screen.getByText('Salary')).toBeInTheDocument();
    expect(toast.error).toHaveBeenCalledWith('Failed to delete the rule');
  });

  it('sends the full id list in the new order when a rule moves down', async () => {
    api.reorder.mockResolvedValue([
      { ...second, position: 0 },
      { ...first, position: 1 },
    ]);
    await renderManager();
    await pickFromMenu('Coffee shops', 'Move down');
    expect(api.reorder).toHaveBeenCalledWith(['b', 'a']);
    const names = screen.getAllByRole('row').slice(1).map((r) => r.textContent);
    expect(names[0]).toContain('Salary');
    expect(names[1]).toContain('Coffee shops');
  });

  it('sends the new order when a rule moves up', async () => {
    api.reorder.mockResolvedValue([second, first]);
    await renderManager();
    await pickFromMenu('Salary', 'Move up');
    expect(api.reorder).toHaveBeenCalledWith(['b', 'a']);
  });

  it('reloads and says the list changed when the reorder is refused with 409', async () => {
    api.reorder.mockRejectedValue(conflict());
    const fresh = [makeRule({ id: 'c', name: 'Added elsewhere' }), first, second];
    api.getAll.mockResolvedValueOnce([first, second]).mockResolvedValueOnce(fresh);
    await renderManager();
    await pickFromMenu('Coffee shops', 'Move down');
    expect(toast.error).toHaveBeenCalledWith(
      'The list of rules changed elsewhere and has been reloaded. Try again',
    );
    expect(api.getAll).toHaveBeenCalledTimes(2);
    expect(screen.getByText('Added elsewhere')).toBeInTheDocument();
  });

  it('reports another reorder failure without reloading', async () => {
    api.reorder.mockRejectedValue(failure());
    await renderManager();
    await pickFromMenu('Coffee shops', 'Move down');
    expect(toast.error).toHaveBeenCalledWith('Failed to change the order of the rules');
    expect(api.getAll).toHaveBeenCalledTimes(1);
  });

  it('duplicates a rule as a disabled copy named "(copy)" and reloads', async () => {
    api.create.mockResolvedValue(makeRule({ id: 'c', name: 'Coffee shops (copy)' }));
    api.getAll
      .mockResolvedValueOnce([first, second])
      .mockResolvedValueOnce([first, second, makeRule({ id: 'c', name: 'Coffee shops (copy)', enabled: false })]);
    await renderManager();
    await pickFromMenu('Coffee shops', 'Duplicate');
    expect(api.create).toHaveBeenCalledWith({
      name: 'Coffee shops (copy)',
      enabled: false,
      triggers: first.triggers,
      condition: first.condition,
      actions: first.actions,
      stopProcessing: false,
    });
    expect(await screen.findByText('Coffee shops (copy)')).toBeInTheDocument();
    expect(toast.success).toHaveBeenCalled();
  });

  it('shortens a name that would not fit the API limit once the suffix is added', async () => {
    const long = makeRule({ id: 'l', name: 'x'.repeat(100) });
    api.getAll.mockResolvedValue([long]);
    api.create.mockResolvedValue(long);
    await renderManager();
    await pickFromMenu('x'.repeat(100), 'Duplicate');
    const sent = api.create.mock.calls[0][0].name as string;
    expect(sent).toHaveLength(100);
    expect(sent.endsWith(' (copy)')).toBe(true);
  });

  it('reports a failed duplicate', async () => {
    api.create.mockRejectedValue(failure());
    await renderManager();
    await pickFromMenu('Coffee shops', 'Duplicate');
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Failed to duplicate the rule'));
  });

  it('opens the run dialog for the chosen rule from the row menu and closes it again', async () => {
    await renderManager();
    await pickFromMenu('Salary', 'Run on existing transactions');
    expect(await screen.findByRole('dialog', { name: 'Run "Salary" on existing transactions' })).toBeInTheDocument();
    expect(api.previewRun).not.toHaveBeenCalled();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});
