import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, act, within } from '@/test/render';
import { WizardSamplesStep } from './WizardSamplesStep';
import { makeDetail, makeReceipt } from './email-receipts-fixtures';

const api = vi.hoisted(() => ({ list: vi.fn(), get: vi.fn() }));
const txApi = vi.hoisted(() => ({ getAll: vi.fn() }));
vi.mock('@/lib/email-receipts-api', () => ({ emailReceiptsApi: { receipts: api } }));
vi.mock('@/lib/transactions', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/transactions')>()),
  transactionsApi: txApi,
}));
vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() }),
}));

const chosen = (id: string) => ({ transactionId: `tx-${id}`, summary: `Order ${id}, 25.00`, subject: `Order ${id}` });
const receipts = ['1', '2', '3', '4', '5', '6', '7'].map((id) => makeReceipt({ id: `r-${id}`, subject: `Order ${id}` }));

async function click(element: HTMLElement) {
  await act(async () => {
    fireEvent.click(element);
  });
  await act(async () => {});
}

async function renderStep(over: Partial<React.ComponentProps<typeof WizardSamplesStep>> = {}) {
  const props = {
    domain: 'allegro.pl',
    picks: {},
    selected: new Set<string>(),
    kind: 'receipt' as const,
    onKindChange: vi.fn(),
    onSubject: vi.fn(),
    onPick: vi.fn(),
    onToggle: vi.fn(),
    onContinue: vi.fn(),
    ...over,
  };
  await act(async () => {
    render(<WizardSamplesStep {...props} />);
  });
  await act(async () => {});
  return props;
}

describe('WizardSamplesStep', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.list.mockResolvedValue(receipts);
    api.get.mockResolvedValue(makeDetail({ id: 'r-1', bodyText: 'Hello from the shop' }));
    txApi.getAll.mockResolvedValue({
      data: [{ id: 'tx-9', transactionDate: '2026-09-02', payeeName: 'Allegro', amount: '-25.0000', currencyCode: 'USD', description: null, isTransfer: false, isVoid: false }],
      pagination: { page: 1, limit: 50, total: 1, totalPages: 1, hasMore: false },
    });
  });

  it('lists the domain\'s emails with the sender domain filter', async () => {
    await renderStep();
    expect(api.list).toHaveBeenCalledWith(undefined, undefined, 'allegro.pl');
    expect(screen.getByRole('row', { name: /Order 1/ })).toBeInTheDocument();
  });

  it('enables the checkbox only for an email that has a transaction, and says why not', async () => {
    await renderStep({ picks: { 'r-1': chosen('1') } });
    expect(screen.getByRole('checkbox', { name: 'Use the email Order 1 as a sample' })).toBeEnabled();
    const blocked = screen.getByRole('checkbox', { name: 'Use the email Order 2 as a sample' });
    expect(blocked).toBeDisabled();
    expect(blocked).toHaveAttribute('title', 'Choose a transaction for this email first.');
  });

  it('allows at most five samples and names the limit on the others', async () => {
    const picks = Object.fromEntries(['1', '2', '3', '4', '5', '6'].map((id) => [`r-${id}`, chosen(id)]));
    const props = await renderStep({ picks, selected: new Set(['r-1', 'r-2', 'r-3', 'r-4', 'r-5']) });
    const sixth = screen.getByRole('checkbox', { name: 'Use the email Order 6 as a sample' });
    expect(sixth).toBeDisabled();
    expect(sixth).toHaveAttribute('title', 'At most 5 samples. Untick one to choose another.');
    // A ticked one can still be unticked.
    await click(screen.getByRole('checkbox', { name: 'Use the email Order 1 as a sample' }));
    expect(props.onToggle).toHaveBeenCalledWith('r-1');
    expect(screen.getByText('5 of 5 samples ticked')).toBeInTheDocument();
  });

  it('continues only with a sample ticked', async () => {
    const props = await renderStep({ picks: { 'r-1': chosen('1') }, selected: new Set(['r-1']) });
    await click(screen.getByRole('button', { name: 'Continue to the assistant' }));
    expect(props.onContinue).toHaveBeenCalledTimes(1);
  });

  it('keeps Continue off with nothing ticked', async () => {
    await renderStep();
    expect(screen.getByRole('button', { name: 'Continue to the assistant' })).toBeDisabled();
  });

  it('has no per-row buttons: the whole row opens the dialog', async () => {
    await renderStep();
    const row = screen.getByRole('row', { name: /Order 1/ });
    expect(within(row).queryByRole('button')).not.toBeInTheDocument();
    expect(screen.queryByRole('columnheader', { name: 'Actions' })).not.toBeInTheDocument();
  });

  it('opens one dialog with the email and the transaction picker when the row is clicked', async () => {
    await renderStep();
    await click(screen.getByText('Order 1'));
    expect(api.get).toHaveBeenCalledWith('r-1');
    const dialog = screen.getByRole('dialog');
    expect(screen.getAllByRole('dialog')).toHaveLength(1);
    expect(dialog).toHaveTextContent('Hello from the shop');
    expect(within(dialog).getByRole('button', { name: 'Use this transaction' })).toBeInTheDocument();
  });

  it('opens the dialog from the keyboard on the focused row', async () => {
    await renderStep();
    const row = screen.getByRole('row', { name: /Order 1/ });
    expect(row).toHaveAttribute('tabindex', '0');
    await act(async () => {
      fireEvent.keyDown(row, { key: 'Enter' });
    });
    await act(async () => {});
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('does not open the dialog when Space is pressed on the row checkbox', async () => {
    await renderStep({ picks: { 'r-1': chosen('1') } });
    await act(async () => {
      fireEvent.keyDown(screen.getByRole('checkbox', { name: 'Use the email Order 1 as a sample' }), { key: ' ' });
    });
    await act(async () => {});
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('does not open the dialog when the row checkbox is clicked', async () => {
    const props = await renderStep({ picks: { 'r-1': chosen('1') } });
    await click(screen.getByRole('checkbox', { name: 'Use the email Order 1 as a sample' }));
    expect(props.onToggle).toHaveBeenCalledWith('r-1');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('starts the transaction search with the wizard domain, and the first request uses it', async () => {
    await renderStep();
    await click(screen.getByText('Order 1'));
    expect(screen.getByRole('searchbox', { name: 'Search by payee, description or amount...' })).toHaveValue('allegro.pl');
    expect(txApi.getAll).toHaveBeenCalledWith(expect.objectContaining({ search: 'allegro.pl' }));
  });

  it('shows the effective date, not the date the email was forwarded', async () => {
    api.list.mockResolvedValue([
      makeReceipt({
        id: 'r-1',
        subject: 'Order 1',
        receivedAt: '2026-09-20T10:00:00.000Z',
        originalSentAt: '2026-08-05T10:00:00.000Z',
        effectiveDate: '2026-08-05T10:00:00.000Z',
      }),
    ]);
    await renderStep();
    expect(screen.getByRole('columnheader', { name: 'Date' })).toBeInTheDocument();
    expect(screen.queryByRole('columnheader', { name: 'Received' })).not.toBeInTheDocument();
    const row = screen.getByRole('row', { name: /Order 1/ });
    expect(row).toHaveTextContent(/2026-08-05|08\/05\/2026|05\/08\/2026|Aug/);
    expect(row).not.toHaveTextContent(/2026-09-20|09\/20\/2026|20\/09\/2026|Sep/);
  });

  it('keeps the chosen transaction for the wizard, writes nothing and closes the dialog', async () => {
    const props = await renderStep();
    await click(screen.getByText('Order 1'));
    await click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Use this transaction' }));
    expect(props.onPick).toHaveBeenCalledWith('r-1', {
      transactionId: 'tx-9',
      summary: expect.stringContaining('Allegro'),
      subject: 'Order 1',
    });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('shows a failed read as an error with a retry, never as no emails', async () => {
    api.list.mockRejectedValueOnce(new Error('down'));
    await renderStep();
    expect(screen.getByRole('alert')).toHaveTextContent('The emails could not be loaded.');
    await click(screen.getByRole('button', { name: 'Try again' }));
    expect(screen.getByRole('row', { name: /Order 1/ })).toBeInTheDocument();
  });

  it('says so when the domain has no emails', async () => {
    api.list.mockResolvedValue([]);
    await renderStep();
    expect(screen.getByText('No emails from this domain')).toBeInTheDocument();
  });

  describe('trade confirmations', () => {
    it('switches to trade mode: an email can be ticked with no transaction, and none is asked for', async () => {
      const props = await renderStep({ kind: 'trade' });
      const box = screen.getByRole('checkbox', { name: 'Use the email Order 2 as a sample' });
      expect(box).toBeEnabled();
      expect(box).not.toHaveAttribute('title');
      expect(screen.getAllByText('Not needed for a trade confirmation').length).toBeGreaterThan(0);
      expect(screen.queryByText('Choose a transaction for this email first.')).not.toBeInTheDocument();
      await click(box);
      // The subject is remembered, since a trade sample has no transaction line to name it.
      expect(props.onSubject).toHaveBeenCalledWith('r-2', 'Order 2');
      expect(props.onToggle).toHaveBeenCalledWith('r-2');
    });

    it('offers the switch, which asks the wizard to change kind', async () => {
      const props = await renderStep();
      await click(screen.getByRole('checkbox', { name: /brokerage trade confirmations/ }));
      expect(props.onKindChange).toHaveBeenCalledWith('trade');
    });

    it('turns back to receipts when the switch is cleared', async () => {
      const props = await renderStep({ kind: 'trade' });
      await click(screen.getByRole('checkbox', { name: /brokerage trade confirmations/ }));
      expect(props.onKindChange).toHaveBeenCalledWith('receipt');
    });

    it('still allows at most five samples', async () => {
      await renderStep({ kind: 'trade', selected: new Set(['r-1', 'r-2', 'r-3', 'r-4', 'r-5']) });
      expect(screen.getByRole('checkbox', { name: 'Use the email Order 6 as a sample' })).toBeDisabled();
    });
  });
});
