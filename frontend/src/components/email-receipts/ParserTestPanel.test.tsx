import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, act, within } from '@/test/render';
import { ParserTestPanel } from './ParserTestPanel';
import { makeReceipt, PARSED_RECEIPT, PARSED_TRADE } from './email-receipts-fixtures';

const api = vi.hoisted(() => ({ list: vi.fn(), test: vi.fn() }));
vi.mock('@/lib/email-receipts-api', () => ({
  emailReceiptsApi: { receipts: { list: api.list }, parsers: { test: api.test } },
}));
vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() }),
}));

const definition = { version: 2 as const, total: ['Total {amount}'] };
const labels = new Map([['cat-1', 'Electronics']]);

async function renderPanel(props: Partial<Parameters<typeof ParserTestPanel>[0]> = {}) {
  await act(async () => {
    render(<ParserTestPanel definition={definition} payeeId="" categoryLabels={labels} {...props} />);
  });
  await act(async () => {});
}

async function choose(id: string) {
  await act(async () => {
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: id } });
  });
}

async function runTest() {
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Test' }));
  });
  await act(async () => {});
}

describe('ParserTestPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.list.mockResolvedValue([
      makeReceipt({ id: 'r-1', subject: 'Order 1', fromAddress: 'a@shop.example' }),
      makeReceipt({ id: 'r-2', subject: 'Order 2', fromAddress: 'b@shop.example' }),
    ]);
  });

  it('cannot test a definition that is not there (the JSON does not parse) and says why', async () => {
    await renderPanel({ definition: null });
    await choose('r-1');
    expect(screen.getByText('The JSON is not valid, so there is nothing to test yet.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Test' })).toBeDisabled();
    expect(api.test).not.toHaveBeenCalled();
  });

  it('dates each option by the effective date, not the forwarding date', async () => {
    api.list.mockResolvedValue([
      makeReceipt({
        id: 'r-1',
        subject: 'Order 1',
        fromAddress: 'a@shop.example',
        receivedAt: '2026-09-20T10:00:00.000Z',
        effectiveDate: '2026-08-05T10:00:00.000Z',
      }),
    ]);
    await renderPanel();
    const option = screen.getByRole('option', { name: /Order 1 from a@shop\.example/ });
    expect(option).toHaveTextContent(/2026-08-05|08\/05\/2026|05\/08\/2026|Aug/);
    expect(option).not.toHaveTextContent(/2026-09-20|09\/20\/2026|20\/09\/2026|Sep 20/);
  });

  it('offers the stored emails and cannot test until one is chosen', async () => {
    await renderPanel();
    expect(api.list).toHaveBeenCalledWith(undefined, 50);
    expect(screen.getByRole('option', { name: /Order 1 from a@shop\.example/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Test' })).toBeDisabled();
  });

  it('tests the definition on the form against the chosen email, with the payee only when there is one', async () => {
    api.test.mockResolvedValue({
      parsed: PARSED_RECEIPT,
      match: { kind: 'unmatched' },
      candidateCount: 4,
      transaction: null,
    });
    await renderPanel({ payeeId: 'payee-1' });
    await choose('r-2');
    await runTest();
    expect(api.test).toHaveBeenCalledWith({ definition, receiptId: 'r-2', payeeId: 'payee-1' });
  });

  it('lists what matched each value under the result', async () => {
    api.test.mockResolvedValue({
      parsed: PARSED_RECEIPT,
      trace: {
        orderId: null,
        total: { entry: 0, pattern: 'Total {amount}', line: { line: 3, text: 'Total 25.00' } },
        paid: null,
        shipping: null,
        discount: null,
        payee: null,
        reference: null,
        requireLine: null,
        skipIfLine: null,
        waitIfLine: null,
        items: [],
      },
      outcome: 'read',
      match: { kind: 'unmatched' },
      candidateCount: 0,
      transaction: null,
    });
    await renderPanel();
    await choose('r-1');
    await runTest();
    expect(screen.getByText('Matched by')).toBeInTheDocument();
    expect(screen.getByText(/entry 1 \(Total \{amount\}\), line 3: Total 25\.00/)).toBeInTheDocument();
    expect(screen.queryByRole('note')).not.toBeInTheDocument();
  });

  it.each([
    ['not_applicable', /would not read this email/],
    ['skip_line', /would set this email aside/],
    ['wait_line', /would hold this email/],
    ['no_html', /reads the HTML part of the email, and this email has none/],
  ])('says when a guard (%s) would stop the pipeline reading the email', async (outcome, text) => {
    api.test.mockResolvedValue({
      parsed: PARSED_RECEIPT,
      outcome,
      match: { kind: 'unmatched' },
      candidateCount: 0,
      transaction: null,
    });
    await renderPanel();
    await choose('r-1');
    await runTest();
    expect(screen.getByRole('note')).toHaveTextContent(text);
  });

  it('shows no trace from a server that sent none', async () => {
    api.test.mockResolvedValue({ parsed: PARSED_RECEIPT, match: { kind: 'unmatched' }, candidateCount: 0, transaction: null });
    await renderPanel();
    await choose('r-1');
    await runTest();
    expect(screen.queryByText('Matched by')).not.toBeInTheDocument();
  });

  it('sends no payee when none is picked', async () => {
    api.test.mockResolvedValue({ parsed: PARSED_RECEIPT, match: { kind: 'unmatched' }, candidateCount: 0, transaction: null });
    await renderPanel();
    await choose('r-1');
    await runTest();
    expect(api.test).toHaveBeenCalledWith({ definition, receiptId: 'r-1' });
  });

  it('shows what the profile read with every amount divided by 10000, and the matched transaction as it is', async () => {
    api.test.mockResolvedValue({
      parsed: PARSED_RECEIPT,
      match: { kind: 'matched', transactionId: 'tx-1', matchKind: 'order_id' },
      candidateCount: 1,
      transaction: { id: 'tx-1', date: '2026-08-30', amount: -25, payeeName: 'Allegro' },
    });
    await renderPanel();
    await choose('r-1');
    await runTest();

    expect(screen.getByText('Total').nextElementSibling).toHaveTextContent('25.00');
    expect(screen.getByText('Shipping').nextElementSibling).toHaveTextContent('5.00');
    const row = screen.getByRole('row', { name: /USB-C cable/ });
    expect(within(row).getByText(/19\.98/)).toBeInTheDocument();
    expect(screen.queryByText(/250,000|199,800/)).not.toBeInTheDocument();
    // The transaction's own amount is an ordinary amount: shown once, not divided again.
    expect(screen.getByText(/found by order number/)).toHaveTextContent(/25\.00/);
    expect(screen.getByText(/found by order number/)).toHaveTextContent('Allegro');
    expect(screen.getByText('Electronics')).toBeInTheDocument();
  });

  it('says when several transactions fit and when none does', async () => {
    api.test.mockResolvedValueOnce({
      parsed: PARSED_RECEIPT,
      match: { kind: 'ambiguous', candidateIds: ['a', 'b'] },
      candidateCount: 2,
      transaction: null,
    });
    await renderPanel();
    await choose('r-1');
    await runTest();
    expect(screen.getByText(/2 transactions fit equally well/)).toBeInTheDocument();

    api.test.mockResolvedValueOnce({
      parsed: PARSED_RECEIPT,
      match: { kind: 'unmatched' },
      candidateCount: 1,
      transaction: null,
    });
    await runTest();
    expect(screen.getByText('No transaction matches, out of 1 candidate.')).toBeInTheDocument();
  });

  it('clears the previous result when another email is chosen', async () => {
    api.test.mockResolvedValue({ parsed: PARSED_RECEIPT, match: { kind: 'unmatched' }, candidateCount: 0, transaction: null });
    await renderPanel();
    await choose('r-1');
    await runTest();
    expect(screen.getByText('Transaction match')).toBeInTheDocument();
    await choose('r-2');
    expect(screen.queryByText('Transaction match')).not.toBeInTheDocument();
  });

  it('shows the server refusal, such as a definition that is not valid, as an alert', async () => {
    api.test.mockRejectedValue({ response: { data: { message: 'The profile definition is not valid: total[0]: capture_missing' } } });
    await renderPanel();
    await choose('r-1');
    await runTest();
    expect(screen.getByRole('alert')).toHaveTextContent('capture_missing');
    expect(screen.queryByText('Transaction match')).not.toBeInTheDocument();
  });

  it('preselects the email the profile is being written for', async () => {
    await renderPanel({ initialReceiptId: 'r-2' });
    expect((screen.getByLabelText('Email') as HTMLSelectElement).value).toBe('r-2');
    expect(screen.getByRole('button', { name: 'Test' })).toBeEnabled();
  });

  it('says there is nothing to test against only when the list loaded empty', async () => {
    api.list.mockResolvedValue([]);
    await renderPanel();
    expect(screen.getByText('No emails are stored yet. Poll the mailbox first.')).toBeInTheDocument();
  });

  it('says the list failed rather than that there are no emails', async () => {
    api.list.mockRejectedValue(new Error('boom'));
    await renderPanel();
    expect(screen.getByRole('alert')).toHaveTextContent('could not be loaded');
    expect(screen.queryByText(/No emails are stored yet/)).not.toBeInTheDocument();
  });

  it('says why a trade read is incomplete and which line read each value', async () => {
    api.test.mockResolvedValue({
      trade: {
        parsed: { ...PARSED_TRADE, complete: false, accountId: null, reason: 'trade_no_account' },
        trace: {
          action: null,
          symbol: { entry: 0, pattern: 'Symbol: {symbol}', line: { line: 4, text: 'Symbol: XCNS' } },
          quantity: null,
          total: null,
          price: null,
          commission: null,
          date: null,
          account: null,
        },
      },
      parsed: { ...PARSED_RECEIPT, total: null, complete: false, reason: 'no_total' },
      outcome: 'read',
      match: { kind: 'unmatched', considered: 0, attempts: [] },
      candidateCount: 0,
      transaction: null,
    });
    await renderPanel();
    await choose('r-1');
    await runTest();
    expect(screen.getByText('The profile could not read a complete trade from this email.')).toBeInTheDocument();
    expect(screen.getByText('The profile could not tell which account this trade is for.')).toBeInTheDocument();
    expect(screen.getByText('Ticker')).toBeInTheDocument();
    expect(screen.getByText(/Symbol: XCNS/)).toBeInTheDocument();
  });

  it('names the account a trade would book to, the currency with its source and the marker that named it', async () => {
    api.test.mockResolvedValue({
      trade: {
        parsed: { ...PARSED_TRADE, currency: 'USD', currencySource: 'marker' },
        trace: {
          action: null,
          symbol: null,
          quantity: null,
          total: null,
          price: null,
          commission: null,
          date: null,
          account: null,
          currency: { entry: 1, pattern: '*U.S. dollars*', line: { line: 9, text: 'Amounts in U.S. dollars' } },
        },
      },
      parsed: { ...PARSED_RECEIPT, total: null, complete: false, reason: 'no_total' },
      outcome: 'read',
      match: { kind: 'unmatched', considered: 0, attempts: [] },
      candidateCount: 0,
      transaction: null,
    });
    await renderPanel({ accounts: [{ value: 'acc-rrsp', label: 'RRSP USD', currencyCode: 'USD', tradable: true }] });
    await choose('r-1');
    await runTest();
    expect(screen.getByText('Books to: RRSP USD (USD)')).toBeInTheDocument();
    expect(screen.getByText('Currency: USD, from a currency marker of the profile')).toBeInTheDocument();
    expect(screen.getByText('Currency marker')).toBeInTheDocument();
    expect(screen.getByText(/entry 2 \(\*U\.S\. dollars\*\), line 9: Amounts in U\.S\. dollars/)).toBeInTheDocument();
  });

  it('shows the trade a trade profile read and no bank-transaction match', async () => {
    api.test.mockResolvedValue({
      trade: { parsed: PARSED_TRADE },
      parsed: { ...PARSED_RECEIPT, total: null, complete: false, reason: 'no_total' },
      outcome: 'read',
      match: { kind: 'unmatched', considered: 0, attempts: [] },
      candidateCount: 0,
      transaction: null,
    });
    await renderPanel();
    await choose('r-1');
    await runTest();
    expect(screen.getByText(/Buy 75\.9878 shares of XCNS for 2,000\.00/)).toBeInTheDocument();
    expect(screen.queryByText('Transaction match')).not.toBeInTheDocument();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('shows the link key and the settlements waiting for a component instead of a transaction match', async () => {
    api.test.mockResolvedValue({
      parsed: { ...PARSED_RECEIPT, linkKey: 'KEY-9' },
      outcome: 'read',
      component: {
        linkKey: 'KEY-9',
        waitingSettlements: [{ id: 's-1', subject: 'Card statement', effectiveDate: '2026-09-01' }],
      },
      match: { kind: 'unmatched', considered: 0, attempts: [] },
      candidateCount: 0,
      transaction: null,
    });
    await renderPanel();
    await choose('r-1');
    await runTest();
    expect(screen.getByText('Purchase email (component): link key KEY-9')).toBeInTheDocument();
    expect(screen.getByText('1 repayment email is waiting for this link key:')).toBeInTheDocument();
    expect(screen.getByText(/Card statement \(/)).toBeInTheDocument();
    expect(screen.queryByText('Transaction match')).not.toBeInTheDocument();
    expect(screen.queryByText(/No transaction matches/)).not.toBeInTheDocument();
  });

  it('says when a component read no link key or nothing waits for it', async () => {
    api.test.mockResolvedValueOnce({
      parsed: PARSED_RECEIPT,
      outcome: 'read',
      component: { linkKey: null, waitingSettlements: [] },
      match: { kind: 'unmatched', considered: 0, attempts: [] },
      candidateCount: 0,
      transaction: null,
    });
    await renderPanel();
    await choose('r-1');
    await runTest();
    expect(screen.getByText(/no link key was read/)).toBeInTheDocument();

    api.test.mockResolvedValueOnce({
      parsed: PARSED_RECEIPT,
      outcome: 'read',
      component: { linkKey: 'KEY-9', waitingSettlements: [] },
      match: { kind: 'unmatched', considered: 0, attempts: [] },
      candidateCount: 0,
      transaction: null,
    });
    await runTest();
    expect(screen.getByText('No repayment email is waiting for this link key.')).toBeInTheDocument();
  });

  it('shows the parts of a settlement with the component each one found, and still the transaction match', async () => {
    api.test.mockResolvedValue({
      parsed: PARSED_RECEIPT,
      outcome: 'read',
      links: [
        {
          partIndex: 0,
          link: 'KEY-9',
          component: { id: 'c-1', subject: 'Order A', effectiveDate: '2026-08-01', profileName: 'Shop purchases' },
          partAmount: 120_000,
          componentNet: 240_000,
          taken: 0,
          outcome: 'scaled',
          several: 1,
        },
        {
          partIndex: 1,
          link: null,
          component: null,
          partAmount: 50_000,
          componentNet: null,
          taken: null,
          outcome: 'no_link',
          several: 0,
        },
      ],
      match: { kind: 'unmatched' },
      candidateCount: 3,
      transaction: null,
    });
    await renderPanel();
    await choose('r-1');
    await runTest();
    const first = screen.getByRole('row', { name: /KEY-9/ });
    expect(within(first).getByText(/Purchase email: Order A \(/)).toHaveTextContent('Profile: Shop purchases.');
    expect(within(first).getByText(/^\$?12\.00$/)).toBeInTheDocument();
    expect(within(first).getByText(/Purchase total: \$?24\.00\. Already used: \$?0\.00\./)).toBeInTheDocument();
    expect(screen.getByText('The part has no link, so it stays one line.')).toBeInTheDocument();
    expect(screen.getByText('No transaction matches, out of 3 candidates.')).toBeInTheDocument();
  });
});
