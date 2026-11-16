import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, act } from '@/test/render';
import { AccountDetailShell } from './AccountDetailShell';
import type { Account } from '@/types/account';

function makeAccount(overrides: Partial<Account> = {}): Account {
  return {
    id: 'acc-1',
    accountType: 'CHEQUING',
    name: 'Everyday Chequing',
    currencyCode: 'CAD',
    currentBalance: 100,
    ...overrides,
  } as Account;
}

describe('AccountDetailShell', () => {
  it('renders the account name and formatted type + currency', () => {
    render(
      <AccountDetailShell account={makeAccount()}>
        <div>body</div>
      </AccountDetailShell>,
    );

    expect(screen.getByText('Everyday Chequing')).toBeInTheDocument();
    expect(screen.getByText(/Chequing - CAD/)).toBeInTheDocument();
    expect(screen.getByText('body')).toBeInTheDocument();
  });

  it('shows only the actions whose handlers are provided', () => {
    render(
      <AccountDetailShell
        account={makeAccount()}
        onViewTransactions={vi.fn()}
        onBack={vi.fn()}
      >
        <div />
      </AccountDetailShell>,
    );

    expect(screen.getByText('View Transactions')).toBeInTheDocument();
    expect(screen.getByText('Back to Accounts')).toBeInTheDocument();
    expect(screen.queryByText('Reconcile')).not.toBeInTheDocument();
    expect(screen.queryByText('Edit Account')).not.toBeInTheDocument();
    expect(screen.queryByText('Export')).not.toBeInTheDocument();
  });

  it('fires the standard action handlers', async () => {
    const onViewTransactions = vi.fn();
    const onReconcile = vi.fn();
    const onEdit = vi.fn();
    const onExport = vi.fn();
    const onBack = vi.fn();
    render(
      <AccountDetailShell
        account={makeAccount()}
        onViewTransactions={onViewTransactions}
        onReconcile={onReconcile}
        onEdit={onEdit}
        onExport={onExport}
        onBack={onBack}
      >
        <div />
      </AccountDetailShell>,
    );

    fireEvent.click(screen.getByText('View Transactions'));
    fireEvent.click(screen.getByText('Reconcile'));
    fireEvent.click(screen.getByText('Edit Account'));
    // Export awaits its handler, so clearing the busy flag lands in a later
    // microtask -- act, not a bare fireEvent.
    await act(async () => {
      fireEvent.click(screen.getByText('Export PDF'));
    });
    fireEvent.click(screen.getByText('Back to Accounts'));

    expect(onViewTransactions).toHaveBeenCalledTimes(1);
    expect(onReconcile).toHaveBeenCalledTimes(1);
    expect(onEdit).toHaveBeenCalledTimes(1);
    expect(onExport).toHaveBeenCalledTimes(1);
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it('puts Edit last in the action row, after type-specific actions', () => {
    render(
      <AccountDetailShell
        account={makeAccount()}
        onViewTransactions={vi.fn()}
        onEdit={vi.fn()}
        headerActions={<button type="button">Refresh Prices</button>}
      >
        <div />
      </AccountDetailShell>,
    );

    const edit = screen.getByRole('button', { name: 'Edit Account' });
    expect(edit.parentElement?.lastElementChild).toBe(edit);
  });

  it('puts going back above the name rather than in the action row', () => {
    render(
      <AccountDetailShell
        account={makeAccount()}
        onViewTransactions={vi.fn()}
        onBack={vi.fn()}
      >
        <div />
      </AccountDetailShell>,
    );

    // Same shape as the securities and payees detail headers: a quiet link
    // above the heading, not another outline button competing with the actions.
    const back = screen.getByRole('button', { name: 'Back to Accounts' });
    const heading = screen.getByRole('heading', { level: 1 });
    expect(
      back.compareDocumentPosition(heading) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it('offers a caret to switch accounts when a list is supplied', () => {
    const onSelectAccount = vi.fn();
    render(
      <AccountDetailShell
        account={makeAccount()}
        accounts={[makeAccount(), makeAccount({ id: 'acc-2', name: 'Savings' })]}
        onSelectAccount={onSelectAccount}
      >
        <div />
      </AccountDetailShell>,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Switch to another account' }));
    fireEvent.click(screen.getByRole('menuitem', { name: /Savings/ }));
    expect(onSelectAccount).toHaveBeenCalledWith('acc-2');
  });

  it('hides the caret when there is nowhere else to go', () => {
    render(
      <AccountDetailShell
        account={makeAccount()}
        accounts={[makeAccount()]}
        onSelectAccount={vi.fn()}
      >
        <div />
      </AccountDetailShell>,
    );
    expect(
      screen.queryByRole('button', { name: 'Switch to another account' }),
    ).not.toBeInTheDocument();
  });

  it('renders type-specific header actions', () => {
    render(
      <AccountDetailShell
        account={makeAccount()}
        headerActions={<button type="button">Refresh Prices</button>}
      >
        <div />
      </AccountDetailShell>,
    );
    expect(screen.getByText('Refresh Prices')).toBeInTheDocument();
  });

  it('renders a loading placeholder instead of the body', () => {
    render(
      <AccountDetailShell account={makeAccount()} isLoading>
        <div>body</div>
      </AccountDetailShell>,
    );
    expect(screen.queryByText('body')).not.toBeInTheDocument();
    expect(screen.getByText('Loading account details...')).toBeInTheDocument();
  });

  it('renders an error with a retry button instead of the body', () => {
    const onRetry = vi.fn();
    render(
      <AccountDetailShell account={makeAccount()} error="Something broke" onRetry={onRetry}>
        <div>body</div>
      </AccountDetailShell>,
    );
    expect(screen.queryByText('body')).not.toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('Something broke');
    fireEvent.click(screen.getByText('Retry'));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('shows the institution logo when an institution is supplied', () => {
    render(
      <AccountDetailShell
        account={makeAccount({ institutionId: 'i-1' })}
        institution={{ id: 'i-1', name: 'TD', hasLogo: true }}
      >
        <div />
      </AccountDetailShell>,
    );
    expect(screen.getByRole('img')).toHaveAttribute('src', '/api/v1/institutions/i-1/logo');
  });
});
