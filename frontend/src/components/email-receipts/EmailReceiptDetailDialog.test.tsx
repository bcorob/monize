import { describe, it, expect, vi, beforeEach } from 'vitest';
import toast from 'react-hot-toast';
import { render, screen, fireEvent, act, within } from '@/test/render';
import { EmailReceiptDetailDialog } from './EmailReceiptDetailDialog';
import { makeDetail, PARSED_DIVIDEND, PARSED_RECEIPT, PARSED_TRADE } from './email-receipts-fixtures';

const api = vi.hoisted(() => ({ get: vi.fn(), link: vi.fn() }));
const txApi = vi.hoisted(() => ({ getAll: vi.fn() }));
vi.mock('@/lib/email-receipts-api', () => ({ emailReceiptsApi: { receipts: api } }));
const cache = vi.hoisted(() => ({ clearAllCache: vi.fn() }));
vi.mock('@/lib/apiCache', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/apiCache')>()),
  clearAllCache: cache.clearAllCache,
}));
vi.mock('@/lib/transactions', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/transactions')>()),
  transactionsApi: txApi,
}));
const accountsApi = vi.hoisted(() => ({ getAll: vi.fn() }));
vi.mock('@/lib/accounts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/accounts')>()),
  accountsApi,
}));
vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() }),
}));

const onClose = vi.fn();
const onChanged = vi.fn();
const labels = new Map([['cat-1', 'Electronics: Cables']]);

const candidate = (id: string, amount: number, description: string | null = null) => ({
  id,
  date: '2026-08-30',
  amount,
  currencyCode: 'USD',
  payeeName: 'Allegro',
  description,
});

async function renderDialog(categoryLabels: ReadonlyMap<string, string> | null = labels) {
  await act(async () => {
    render(
      <EmailReceiptDetailDialog receiptId="r-1" categoryLabels={categoryLabels} onClose={onClose} onChanged={onChanged} />,
    );
  });
  await act(async () => {});
}

async function renderDialogWithUnmount() {
  let result!: ReturnType<typeof render>;
  await act(async () => {
    result = render(<EmailReceiptDetailDialog receiptId="r-1" categoryLabels={labels} onClose={onClose} onChanged={onChanged} />);
  });
  await act(async () => {});
  return result;
}

describe('EmailReceiptDetailDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    accountsApi.getAll.mockResolvedValue([]);
    api.get.mockResolvedValue(makeDetail());
    txApi.getAll.mockResolvedValue({
      data: [
        { id: 'tx-p', transactionDate: '2026-09-02', payeeName: 'Allegro', amount: '-25.0000', currencyCode: 'USD', description: null, isTransfer: false, isVoid: false },
      ],
      pagination: { page: 1, limit: 50, total: 1, totalPages: 1, hasMore: false },
    });
  });

  it('loads the email and shows its headers', async () => {
    await renderDialog();
    expect(api.get).toHaveBeenCalledWith('r-1');
    const dialog = screen.getByRole('dialog', { name: 'Email receipt' });
    expect(within(dialog).getByText('orders@allegro.pl')).toBeInTheDocument();
    expect(within(dialog).getByText('Your order 123')).toBeInTheDocument();
    expect(within(dialog).getByText('No transaction found')).toBeInTheDocument();
    expect(within(dialog).getByText('None')).toBeInTheDocument();
  });

  it('shows the text as plain text in a scrollable block, never as markup', async () => {
    api.get.mockResolvedValue(
      makeDetail({ bodyText: 'Hello <b>bold</b> <img src=x onerror=alert(1)> <script>alert(1)</script>' }),
    );
    await renderDialog();
    // This text holds five tags, so it is offered as HTML by default (in the sandboxed
    // frame); the Text view shows the same characters as characters.
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Text' }));
    });
    const text = screen.getByLabelText('Text of the email');
    expect(text.tagName).toBe('PRE');
    expect(text.className).toMatch(/overflow-auto/);
    expect(text.textContent).toBe('Hello <b>bold</b> <img src=x onerror=alert(1)> <script>alert(1)</script>');
    expect(text.querySelector('b, img, script')).toBeNull();
  });

  describe('the body of the email', () => {
    const html = '<html><body><h1>Receipt</h1><p>Total <b>25.00</b></p><img src="https://tracker.example/p.gif"></body></html>';

    it('shows the HTML in a frame by default, with no scripts, origin, forms or popups, and says remote images are not loaded', async () => {
      api.get.mockResolvedValue(makeDetail({ bodyText: 'Receipt\nTotal 25.00', bodyHtml: html }));
      await renderDialog();

      const frame = screen.getByTitle('The email as its sender formatted it') as HTMLIFrameElement;
      expect(frame.tagName).toBe('IFRAME');
      // An EMPTY sandbox: every restriction on.
      expect(frame.getAttribute('sandbox')).toBe('');
      expect(frame.getAttribute('srcdoc')).toContain('<h1>Receipt</h1>');
      expect(screen.getByText('Remote images are not loaded.')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'HTML' })).toHaveAttribute('aria-pressed', 'true');
      expect(screen.getByRole('button', { name: 'Text' })).toHaveAttribute('aria-pressed', 'false');
      expect(screen.queryByLabelText('Text of the email')).not.toBeInTheDocument();
    });

    it('starts the frame\'s document with the CSP meta and the base target, before any of the email', async () => {
      api.get.mockResolvedValue(makeDetail({ bodyHtml: html }));
      await renderDialog();

      const srcdoc = (screen.getByTitle('The email as its sender formatted it') as HTMLIFrameElement).getAttribute('srcdoc') as string;
      expect(
        srcdoc.startsWith(
          `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data: cid:; style-src 'unsafe-inline'; font-src data:"><base target="_blank">`,
        ),
      ).toBe(true);
      expect(srcdoc.indexOf('<html>')).toBeGreaterThan(srcdoc.indexOf('<base target="_blank">'));
    });

    it('switches to the plain text and back, and drops the remote-images note in the text view', async () => {
      api.get.mockResolvedValue(makeDetail({ bodyText: 'Receipt\nTotal 25.00', bodyHtml: html }));
      await renderDialog();

      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Text' }));
      });
      expect(screen.getByLabelText('Text of the email').textContent).toBe('Receipt\nTotal 25.00');
      expect(screen.queryByTitle('The email as its sender formatted it')).not.toBeInTheDocument();
      expect(screen.queryByText('Remote images are not loaded.')).not.toBeInTheDocument();

      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'HTML' }));
      });
      expect(screen.getByTitle('The email as its sender formatted it')).toBeInTheDocument();
    });

    it('never puts the email\'s HTML into the page itself', async () => {
      api.get.mockResolvedValue(
        makeDetail({ bodyHtml: '<h1 id="injected">Hi</h1><script>window.pwned = 1</script><img src=x onerror="window.pwned = 2">' }),
      );
      await renderDialog();

      expect(document.querySelector('#injected')).toBeNull();
      expect(document.body.querySelector('script')).toBeNull();
      expect((window as unknown as { pwned?: number }).pwned).toBeUndefined();
    });

    it('has no toggle and no frame for an email with no HTML', async () => {
      api.get.mockResolvedValue(makeDetail({ bodyText: 'Plain total 25.00', bodyHtml: null }));
      await renderDialog();

      expect(screen.queryByRole('button', { name: 'HTML' })).not.toBeInTheDocument();
      expect(screen.queryByTitle('The email as its sender formatted it')).not.toBeInTheDocument();
      expect(screen.queryByText('Remote images are not loaded.')).not.toBeInTheDocument();
      expect(screen.getByLabelText('Text of the email').textContent).toBe('Plain total 25.00');
    });

    it('treats a text that is itself HTML, with no HTML part kept, as HTML in the same frame', async () => {
      api.get.mockResolvedValue(makeDetail({ bodyText: '<!DOCTYPE html><html><body><p>Total 25.00</p></body></html>', bodyHtml: null }));
      await renderDialog();

      const frame = screen.getByTitle('The email as its sender formatted it');
      expect(frame.getAttribute('sandbox')).toBe('');
      expect(frame.getAttribute('srcdoc')).toContain('<p>Total 25.00</p>');
      // and the text view still offers the stored text, as text
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Text' }));
      });
      expect(screen.getByLabelText('Text of the email').textContent).toContain('<p>Total 25.00</p>');
    });
  });

  describe('the lines a profile reads', () => {
    it('offers a Lines view with the text lines and a source switch to the HTML lines', async () => {
      api.get.mockResolvedValue(
        makeDetail({
          bodyText: 'Order number: A-1\nWidget 12,00',
          bodyHtml: '<table><tr><td>Widget</td><td>12,00</td></tr></table>',
          lines: { text: ['Order number: A-1', 'Widget 12,00'], html: ['Widget', '12,00'] },
        }),
      );
      await renderDialog();

      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Lines' }));
      });
      expect(screen.getByRole('button', { name: 'Lines' })).toHaveAttribute('aria-pressed', 'true');
      expect(screen.queryByTitle('The email as its sender formatted it')).not.toBeInTheDocument();
      const items = within(screen.getByRole('list', { name: 'Numbered lines of the email' })).getAllByRole('listitem');
      expect(items.map((item) => item.textContent)).toEqual(['1Order number: A-1', '2Widget 12,00']);

      await act(async () => {
        fireEvent.click(screen.getByRole('group', { name: 'Lines source' }).querySelectorAll('button')[1]);
      });
      const htmlItems = within(screen.getByRole('list', { name: 'Numbered lines of the email' })).getAllByRole('listitem');
      expect(htmlItems.map((item) => item.textContent)).toEqual(['1Widget', '212,00']);
    });

    it('offers the Lines view for an email with no HTML too, with the HTML source unavailable', async () => {
      api.get.mockResolvedValue(makeDetail());
      await renderDialog();
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Lines' }));
      });
      expect(within(screen.getByRole('group', { name: 'Lines source' })).getByRole('button', { name: 'HTML' })).toBeDisabled();
      expect(screen.getByText('This email has no HTML part, so a profile that reads HTML cannot read it.')).toBeInTheDocument();
    });

    it('still shows the body when the server sent no lines (an older server)', async () => {
      const detail = makeDetail();
      api.get.mockResolvedValue({ ...detail, lines: undefined });
      await renderDialog();
      expect(screen.queryByRole('button', { name: 'Lines' })).not.toBeInTheDocument();
      expect(screen.getByLabelText('Text of the email')).toBeInTheDocument();
    });
  });

  describe('structured data (schema.org)', () => {
    it('says not found when the email carries no order', async () => {
      await renderDialog();
      expect(screen.getByRole('heading', { name: 'Structured data (schema.org)' })).toBeInTheDocument();
      expect(screen.getByText('Not found')).toBeInTheDocument();
    });

    it('shows the order found, with its lines', async () => {
      api.get.mockResolvedValue(
        makeDetail({
          structuredOrder: {
            orderNumber: 'EX-9',
            seller: 'Example Shop',
            currency: 'USD',
            orderDate: null,
            total: 150_000,
            discount: null,
            items: [{ name: 'Widget', qty: 1, unitPrice: 150_000, amount: 150_000 }],
          },
        }),
      );
      await renderDialog();
      expect(screen.getByText('Found')).toBeInTheDocument();
      expect(screen.getByText('EX-9')).toBeInTheDocument();
      expect(screen.getByText('Example Shop')).toBeInTheDocument();
      expect(screen.getByText('Widget')).toBeInTheDocument();
    });

    it('names structured data as the reader, with the badge and the reason, when a receipt was read from it', async () => {
      api.get.mockResolvedValue(
        makeDetail({
          status: 'review',
          displayState: 'proposed',
          statusReason: 'schema_org',
          parsed: { ...PARSED_RECEIPT, complete: true, reason: null, source: 'schema_org' },
        }),
      );
      await renderDialog();
      expect(screen.getByText('Read from structured data')).toBeInTheDocument();
      expect(
        screen.getByText('No profile was needed: the order was read from the structured data (schema.org) in the email.'),
      ).toBeInTheDocument();
      // The Parser row says where the reading came from instead of "None".
      expect(screen.queryByText('None')).not.toBeInTheDocument();
      expect(screen.getAllByText('Structured data').length).toBeGreaterThan(0);
    });

    it('explains a parse that failed for want of an HTML part', async () => {
      api.get.mockResolvedValue(makeDetail({ status: 'parse_failed', statusReason: 'no_html', parserName: 'Shop HTML' }));
      await renderDialog();
      expect(screen.getByText('This profile reads the HTML part of the email, and this email has none.')).toBeInTheDocument();
    });
  });

  describe('a forwarded email', () => {
    it('says who forwarded it and when the shop sent it, beside the day it arrived', async () => {
      api.get.mockResolvedValue(
        makeDetail({
          forwardedBy: 'alice.example@gmail.example.com',
          originalSentAt: '2026-08-10T08:15:00.000Z',
          effectiveDate: '2026-08-10T08:15:00.000Z',
          receivedAt: '2026-09-10T10:00:00.000Z',
        }),
      );
      await renderDialog();

      const dialog = screen.getByRole('dialog', { name: 'Email receipt' });
      expect(within(dialog).getByText('Forwarded by')).toBeInTheDocument();
      expect(within(dialog).getByText('alice.example@gmail.example.com')).toBeInTheDocument();
      expect(within(dialog).getByText('Sent by the shop')).toBeInTheDocument();
      expect(within(dialog).getByText('Received')).toBeInTheDocument();
    });

    it('says nothing about forwarding for an email that was not', async () => {
      await renderDialog();
      expect(screen.queryByText('Forwarded by')).not.toBeInTheDocument();
      expect(screen.queryByText('Sent by the shop')).not.toBeInTheDocument();
    });

    it('starts the transaction picker around the shop\'s day, not the day it was forwarded', async () => {
      api.get.mockResolvedValue(
        makeDetail({
          status: 'unmatched',
          forwardedBy: 'alice.example@gmail.example.com',
          originalSentAt: '2026-08-10T08:15:00.000Z',
          effectiveDate: '2026-08-10T08:15:00.000Z',
          receivedAt: '2026-09-10T10:00:00.000Z',
        }),
      );
      await renderDialog();

      expect(txApi.getAll).toHaveBeenCalledWith({ startDate: '2026-08-07', endDate: '2026-08-24', limit: 50 });
    });
  });

  it('says so when the email has no text', async () => {
    api.get.mockResolvedValue(makeDetail({ bodyText: '' }));
    await renderDialog();
    expect(screen.getByText('The email has no text.')).toBeInTheDocument();
  });

  it('shows what the profile read, amounts divided by 10000', async () => {
    api.get.mockResolvedValue(
      makeDetail({
        status: 'review',
        displayState: 'proposed',
        parserName: 'Allegro parser',
        matchKind: 'order_id',
        parsed: PARSED_RECEIPT,
        transaction: { id: 'tx-1', date: '2026-08-30', amount: -25, currencyCode: 'USD', payeeName: 'Allegro' },
      }),
    );
    await renderDialog();
    expect(screen.getByText('Waiting for approval')).toBeInTheDocument();
    expect(screen.getByText('Allegro parser')).toBeInTheDocument();
    expect(screen.getByText('Order number', { selector: 'dt' }).nextElementSibling).toHaveTextContent('123');
    expect(screen.getByText('Total').nextElementSibling).toHaveTextContent('$25.00');
    expect(within(screen.getByRole('row', { name: /USB-C cable/ })).getByText('$19.98')).toBeInTheDocument();
    expect(screen.getByText('Electronics: Cables')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'View transaction' })).toHaveAttribute(
      'href',
      '/transactions?targetTransactionId=tx-1',
    );
  });

  describe('a trade confirmation', () => {
    const tradeDetail = (over = {}) =>
      makeDetail({
        status: 'review',
        displayState: 'proposed',
        parserName: 'Wealthsimple',
        isTrade: true,
        tradeSource: 'profile',
        trade: PARSED_TRADE,
        ...over,
      });
    const tradeCandidate = { id: 'it-1', date: '2026-10-15', amount: 2000, currencyCode: 'CAD', payeeName: 'XCNS.TO', description: null, quantity: 75.9878 };
    const resolvedProposal = {
      accountName: 'CA RRSP - Brokerage',
      date: '2026-10-15',
      action: 'BUY' as const,
      symbol: 'XCNS.TO',
      securityName: 'iShares Core Conservative Balanced ETF Portfolio',
      quantity: 75.9878,
      price: 26.32,
      commission: 0,
      totalAmount: 2000,
      currencyCode: 'CAD',
    };

    it('shows the proposal beside the reading: the account and the security the trade resolved to', async () => {
      api.get.mockResolvedValue(tradeDetail({ aiReviewRequestId: 'rq-1', tradeProposal: resolvedProposal }));
      await renderDialog();
      expect(screen.getByRole('heading', { name: 'Trade read from the email' })).toBeInTheDocument();
      expect(screen.getByText(/Buy 75\.9878 shares of XCNS for 2,000\.00/)).toBeInTheDocument();
      expect(screen.getByRole('heading', { name: 'What its proposal would book' })).toBeInTheDocument();
      expect(screen.getByText('Account: CA RRSP - Brokerage')).toBeInTheDocument();
      expect(screen.getByText('Security: iShares Core Conservative Balanced ETF Portfolio')).toBeInTheDocument();
      expect(screen.getByRole('link', { name: 'Review it in the inbox' })).toBeInTheDocument();
    });

    it('names the account the rules chose, with its currency, so two RRSPs printed alike are told apart', async () => {
      accountsApi.getAll.mockResolvedValue([
        { id: 'acc-rrsp', name: 'RRSP', currencyCode: 'USD', accountType: 'INVESTMENT', accountSubType: 'INVESTMENT_BROKERAGE', isClosed: false },
        { id: 'acc-rrsp-cad', name: 'RRSP', currencyCode: 'CAD', accountType: 'INVESTMENT', accountSubType: 'INVESTMENT_BROKERAGE', isClosed: false },
      ]);
      api.get.mockResolvedValue(tradeDetail({ trade: { ...PARSED_TRADE, currency: 'USD', currencySource: 'amount' } }));
      await renderDialog();
      expect(accountsApi.getAll).toHaveBeenCalledWith(true);
      expect(screen.getByText('Books to: RRSP (USD)')).toBeInTheDocument();
    });

    it('heads the proposal as the AI agent\'s when "Recognize as a trade" wrote it', async () => {
      api.get.mockResolvedValue(
        tradeDetail({ aiReviewRequestId: 'rq-1', tradeProposal: resolvedProposal, tradeRequestSource: 'ai' }),
      );
      await renderDialog();
      expect(screen.getByRole('heading', { name: 'Trade read from the email' })).toBeInTheDocument();
      expect(screen.getByRole('heading', { name: 'Trade the AI agent proposes' })).toBeInTheDocument();
      expect(screen.queryByRole('heading', { name: 'What its proposal would book' })).not.toBeInTheDocument();
    });

    it('shows no proposal section for a reading with no proposal waiting', async () => {
      api.get.mockResolvedValue(tradeDetail());
      await renderDialog();
      expect(screen.queryByRole('heading', { name: 'What its proposal would book' })).not.toBeInTheDocument();
      expect(screen.queryByText(/^Account: /)).not.toBeInTheDocument();
    });

    it('offers the link for every email the server would link, a partial reading and a person-ignored one included', async () => {
      for (const over of [
        { status: 'parse_failed', statusReason: 'trade_no_account', displayState: null },
        { status: 'ignored', statusReason: null, displayState: null },
      ]) {
        api.get.mockResolvedValue(tradeDetail({ ...over, candidates: [tradeCandidate] }));
        const { unmount } = await renderDialogWithUnmount();
        expect(screen.getByRole('heading', { name: 'Existing transactions that could be this trade' })).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Link to this transaction' })).toBeInTheDocument();
        unmount();
      }
    });

    it('lists no candidates for an email already linked, whose own row would be among them', async () => {
      api.get.mockResolvedValue(
        tradeDetail({
          status: 'ignored',
          statusReason: 'trade_linked',
          displayState: null,
          investmentTransaction: { id: 'it-1', date: '2026-10-15', action: 'BUY', symbol: 'XCNS.TO', quantity: 75.9878, totalAmount: 2000, currencyCode: 'CAD' },
          candidates: [tradeCandidate],
        }),
      );
      await renderDialog();
      expect(screen.queryByRole('heading', { name: 'Existing transactions that could be this trade' })).not.toBeInTheDocument();
      expect(screen.queryByText('75.9878 shares')).not.toBeInTheDocument();
      expect(screen.queryByText(/No investment transaction of this account/)).not.toBeInTheDocument();
    });

    it('lists the existing investment transactions a trade email could be, and links the chosen one', async () => {
      api.get.mockResolvedValue(
        tradeDetail({
          status: 'ignored',
          statusReason: 'trade_exists',
          displayState: null,
          candidates: [
            { id: 'it-1', date: '2026-10-15', amount: 2000, currencyCode: 'CAD', payeeName: 'XCNS.TO', description: null, quantity: 75.9878 },
          ],
        }),
      );
      const linked = {
        id: 'it-1',
        date: '2026-10-15',
        action: 'BUY',
        symbol: 'XCNS.TO',
        quantity: 75.9878,
        totalAmount: 2000,
        currencyCode: 'CAD',
      };
      api.link.mockResolvedValue(
        tradeDetail({
          status: 'ignored',
          statusReason: 'trade_linked',
          displayState: null,
          investmentTransaction: linked,
          candidates: [
            { id: 'it-1', date: '2026-10-15', amount: 2000, currencyCode: 'CAD', payeeName: 'XCNS.TO', description: null, quantity: 75.9878 },
          ],
        }),
      );
      await renderDialog();
      expect(screen.getByRole('heading', { name: 'Existing transactions that could be this trade' })).toBeInTheDocument();
      expect(screen.getByText(/a scheduled bill or deposit it pays is marked paid/)).toBeInTheDocument();
      // The candidate's shares are formatted, not the raw database string.
      expect(screen.getByText('75.9878 shares')).toBeInTheDocument();
      expect(screen.queryByText('Several transactions fit this email equally well. Choose the one it paid for.')).not.toBeInTheDocument();
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Link to this transaction' }));
      });
      await act(async () => {});
      expect(api.link).toHaveBeenCalledWith('r-1', 'it-1');
      expect(toast.success).toHaveBeenCalledWith('Email linked to the transaction');
      expect(screen.getByText('Linked to the transaction it reports, so nothing was proposed.')).toBeInTheDocument();
      // Linking can mark a scheduled bill paid: every cached read of it is dropped.
      expect(cache.clearAllCache).toHaveBeenCalled();
      // The email now says what it is linked to, and offers no second link.
      expect(screen.getByText(/Bought 75\.9878 XCNS\.TO for/)).toBeInTheDocument();
      expect(screen.getByRole('link', { name: 'View transaction' })).toHaveAttribute('href', '/investments?edit=it-1');
      expect(screen.queryByRole('button', { name: 'Link to this transaction' })).not.toBeInTheDocument();
      // Linked, the email lists no candidates: its own row would be the first.
      expect(screen.queryByRole('heading', { name: 'Existing transactions that could be this trade' })).not.toBeInTheDocument();
    });

    it('explains why there is nothing to link when no investment transaction fits', async () => {
      api.get.mockResolvedValue(tradeDetail({ candidates: [] }));
      await renderDialog();
      expect(screen.getByText(/No investment transaction of this account, action and ticker/)).toBeInTheDocument();
      expect(screen.getByText(/None yet: the trade is booked when you approve its proposal/)).toBeInTheDocument();
    });

    it('offers no link, and lists no candidates, once the proposal was applied', async () => {
      api.get.mockResolvedValue(
        tradeDetail({
          displayState: 'applied',
          candidates: [{ id: 'it-1', date: '2026-10-15', amount: 2000, currencyCode: 'CAD', payeeName: 'XCNS.TO', description: null }],
        }),
      );
      await renderDialog();
      expect(screen.queryByRole('button', { name: 'Link to this transaction' })).not.toBeInTheDocument();
      expect(screen.queryByRole('heading', { name: 'Existing transactions that could be this trade' })).not.toBeInTheDocument();
    });

    it('shows the trade the profile read instead of a receipt, with no candidates or structured data', async () => {
      api.get.mockResolvedValue(tradeDetail());
      await renderDialog();
      expect(screen.getByRole('heading', { name: 'Trade read from the email' })).toBeInTheDocument();
      expect(screen.getByText(/Buy 75\.9878 shares of XCNS for 2,000\.00/)).toBeInTheDocument();
      expect(screen.queryByText('What the profile read')).not.toBeInTheDocument();
      expect(screen.queryByText('Nothing has been read from this email yet.')).not.toBeInTheDocument();
      expect(screen.queryByText('Structured data (schema.org)')).not.toBeInTheDocument();
    });

    it('does not offer to pick a bank transaction for an email that creates one', async () => {
      api.get.mockResolvedValue(tradeDetail({ status: 'parse_failed', statusReason: 'trade_no_symbol', displayState: null }));
      await renderDialog();
      expect(screen.getByText('The profile found no ticker symbol in this email.')).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /choose a transaction|pick a transaction/i })).not.toBeInTheDocument();
    });

    it('lists a dividend\'s candidates without a share count, which says nothing of a dividend', async () => {
      api.get.mockResolvedValue(
        tradeDetail({
          trade: PARSED_DIVIDEND,
          status: 'ignored',
          statusReason: 'trade_exists',
          displayState: null,
          candidates: [{ ...tradeCandidate, amount: 12.34, quantity: 0 }],
        }),
      );
      await renderDialog();
      expect(screen.getByText(/^Dividend from XCNS of 12\.34/)).toBeInTheDocument();
      expect(screen.getByRole('heading', { name: 'Existing transactions that could be this trade' })).toBeInTheDocument();
      expect(screen.queryByText('0 shares')).not.toBeInTheDocument();
    });

    it('says why a trade already in the ledger was not proposed', async () => {
      api.get.mockResolvedValue(tradeDetail({ status: 'ignored', statusReason: 'trade_exists', displayState: null }));
      await renderDialog();
      expect(screen.getByText('Your accounts already hold this trade, so nothing was proposed.')).toBeInTheDocument();
    });
  });

  describe('an email the AI reads as a trade (no profile)', () => {
    const proposal = {
      accountName: 'CA RRSP - Brokerage',
      date: '2026-10-15',
      action: 'BUY' as const,
      symbol: 'XCNS',
      securityName: 'iShares Core Conservative Balanced ETF Portfolio',
      quantity: 75.9878,
      price: 26.3200145286,
      commission: 0,
      totalAmount: 2000,
      currencyCode: 'CAD',
    };
    const aiTrade = (over = {}) =>
      makeDetail({
        fromAddress: 'notifications@o.wealthsimple.com',
        status: 'review',
        displayState: 'proposed',
        aiReviewRequestId: 'rq-1',
        isTrade: true,
        tradeSource: 'ai',
        trade: null,
        tradeProposal: proposal,
        ...over,
      });

    it('shows the trade the AI proposes, not a receipt, and where to approve it', async () => {
      api.get.mockResolvedValue(aiTrade());
      await renderDialog();
      expect(screen.getByRole('heading', { name: 'Trade the AI agent proposes' })).toBeInTheDocument();
      expect(screen.getByText(/Buy 75\.9878 shares of XCNS for/)).toBeInTheDocument();
      expect(screen.getByText('Account: CA RRSP - Brokerage')).toBeInTheDocument();
      expect(screen.getByText('Security: iShares Core Conservative Balanced ETF Portfolio')).toBeInTheDocument();
      expect(screen.getByText(/^Price: /)).toBeInTheDocument();
      // A zero commission is a known zero, shown as a figure.
      expect(screen.getByText(/^Commission: /)).toBeInTheDocument();
      expect(screen.getByRole('link', { name: 'Review it in the inbox' })).toHaveAttribute('href', '/ai-reviews?kind=email_receipt');
      expect(screen.getByText('None: the AI agent reads it as a trade')).toBeInTheDocument();
      expect(screen.getByText("None yet: the trade is booked when you approve the AI agent's proposal.")).toBeInTheDocument();
      // None of the receipt sections apply to it.
      expect(screen.queryByText('What the profile read')).not.toBeInTheDocument();
      expect(screen.queryByText('Nothing has been read from this email yet.')).not.toBeInTheDocument();
      expect(screen.queryByText('Structured data (schema.org)')).not.toBeInTheDocument();
      expect(screen.queryByText('No transaction found')).not.toBeInTheDocument();
    });

    it('says the AI has not proposed it yet while the request waits', async () => {
      api.get.mockResolvedValue(aiTrade({ displayState: 'pending_ai', tradeProposal: null }));
      await renderDialog();
      expect(screen.getByText(/The AI agent has not proposed the trade yet/)).toBeInTheDocument();
      expect(screen.queryByText(/^Account: /)).not.toBeInTheDocument();
    });

    it('says no proposal waits once it was dismissed', async () => {
      api.get.mockResolvedValue(aiTrade({ displayState: 'dismissed', tradeProposal: null }));
      await renderDialog();
      expect(screen.getByText('No proposal from the AI agent is waiting for this email.')).toBeInTheDocument();
    });

    it('shows the booked investment transaction once the proposal was approved', async () => {
      api.get.mockResolvedValue(
        aiTrade({
          displayState: 'applied',
          tradeProposal: null,
          investmentTransaction: {
            id: 'it-9',
            date: '2026-10-15',
            action: 'BUY',
            symbol: 'XCNS',
            quantity: 75.9878,
            totalAmount: 2000,
            currencyCode: 'CAD',
          },
        }),
      );
      await renderDialog();
      expect(screen.getByText("Booked from the AI agent's proposal: see the transaction above.")).toBeInTheDocument();
      expect(screen.getByText(/Bought 75\.9878 XCNS for/)).toBeInTheDocument();
      expect(screen.getByRole('link', { name: 'View transaction' })).toHaveAttribute('href', '/investments?edit=it-9');
    });

    it('shows a cash dividend the AI proposes with no share count and no price', async () => {
      api.get.mockResolvedValue(
        aiTrade({ tradeProposal: { ...proposal, action: 'DIVIDEND', quantity: null, price: null, totalAmount: 12.34 } }),
      );
      await renderDialog();
      expect(screen.getByText(/^Dividend from XCNS of .*12\.34, dated /)).toBeInTheDocument();
      expect(screen.queryByText(/null/)).not.toBeInTheDocument();
      expect(screen.queryByText(/^Price: /)).not.toBeInTheDocument();
      expect(screen.queryByText(/\d shares/)).not.toBeInTheDocument();
      expect(screen.getByText('Account: CA RRSP - Brokerage')).toBeInTheDocument();
    });

    it('names the shares and the amount per share of a dividend proposal that states them', async () => {
      api.get.mockResolvedValue(
        aiTrade({ tradeProposal: { ...proposal, action: 'DIVIDEND', quantity: 100, price: 0.1234, totalAmount: 12.34 } }),
      );
      await renderDialog();
      expect(screen.getByText('Paid on 100 shares')).toBeInTheDocument();
      expect(screen.getByText(/^Amount per share: /)).toBeInTheDocument();
      expect(screen.queryByText(/^Price: /)).not.toBeInTheDocument();
    });

    it('shows a reinvested dividend the AI proposes with its shares', async () => {
      api.get.mockResolvedValue(aiTrade({ tradeProposal: { ...proposal, action: 'REINVEST', quantity: 0.4688 } }));
      await renderDialog();
      expect(screen.getByText(/^Reinvest a dividend in 0\.4688 shares of XCNS for/)).toBeInTheDocument();
      expect(screen.getByText(/^Price: /)).toBeInTheDocument();
    });

    it('names a booked dividend and a booked reinvestment as what they are, never as bought', async () => {
      const booked = { id: 'it-9', date: '2026-10-15', symbol: 'XCNS', totalAmount: 12.34, currencyCode: 'CAD' };
      api.get.mockResolvedValue(
        aiTrade({
          displayState: 'applied',
          tradeProposal: null,
          investmentTransaction: { ...booked, action: 'DIVIDEND', quantity: 0 },
        }),
      );
      const { unmount } = await renderDialogWithUnmount();
      expect(screen.getByText(/^Dividend from XCNS of .*12\.34 on /)).toBeInTheDocument();
      expect(screen.queryByText(/Bought/)).not.toBeInTheDocument();
      unmount();

      api.get.mockResolvedValue(
        aiTrade({
          displayState: 'applied',
          tradeProposal: null,
          investmentTransaction: { ...booked, action: 'REINVEST', quantity: 0.4688 },
        }),
      );
      await renderDialog();
      expect(screen.getByText(/^Reinvested a dividend in 0\.4688 XCNS for .*12\.34 on /)).toBeInTheDocument();
      expect(screen.queryByText(/Bought/)).not.toBeInTheDocument();
    });

    it('offers no bank transaction to pick, whatever its status', async () => {
      api.get.mockResolvedValue(aiTrade({ status: 'unmatched', displayState: null, tradeProposal: null }));
      await renderDialog();
      expect(txApi.getAll).not.toHaveBeenCalled();
      expect(screen.queryByRole('button', { name: 'Link to this transaction' })).not.toBeInTheDocument();
    });
  });

  it('says nothing has been read, rather than showing an empty result, when there is no parse', async () => {
    await renderDialog();
    expect(screen.getByText('Nothing has been read from this email yet.')).toBeInTheDocument();
  });

  it('says why the email is in its state, and the review request note', async () => {
    api.get.mockResolvedValue(
      makeDetail({
        status: 'review',
        displayState: 'dismissed',
        statusReason: 'amount_differs',
        requestNote: 'The lines do not add up.',
      }),
    );
    await renderDialog();
    expect(screen.getByText(/The parsed total differs from the transaction amount/)).toBeInTheDocument();
    expect(screen.getByText('Review request (Dismissed): The lines do not add up.')).toBeInTheDocument();
  });

  it('shows a reason it has no sentence for as it is', async () => {
    api.get.mockResolvedValue(makeDetail({ statusReason: 'brand_new_reason' }));
    await renderDialog();
    expect(screen.getByText('Reason: brand_new_reason')).toBeInTheDocument();
  });

  describe('candidates', () => {
    const ambiguous = () =>
      makeDetail({
        status: 'ambiguous',
        candidates: [candidate('tx-a', -25, 'Order 123'), candidate('tx-b', -25)],
      });

    it('lists the transactions that fit, each with a link button', async () => {
      api.get.mockResolvedValue(ambiguous());
      await renderDialog();
      expect(screen.getAllByRole('button', { name: 'Link to this transaction' })).toHaveLength(2);
      expect(screen.getByText('Order 123')).toBeInTheDocument();
    });

    it('draws an address in a candidate\'s description as a link, as the register does', async () => {
      api.get.mockResolvedValue(
        makeDetail({ status: 'ambiguous', candidates: [candidate('tx-a', -25, 'Ticket https://shop.example/orders/123')] }),
      );
      await renderDialog();
      expect(screen.getByRole('link', { name: /shop\.example\/orders\/123/ })).toHaveAttribute(
        'href',
        'https://shop.example/orders/123',
      );
    });

    it('links the email to the chosen transaction, then shows the updated email', async () => {
      api.get.mockResolvedValue(ambiguous());
      api.link.mockResolvedValue(
        makeDetail({
          status: 'review',
          displayState: 'proposed',
          matchKind: 'manual',
          transaction: { id: 'tx-b', date: '2026-08-30', amount: -25, currencyCode: 'USD', payeeName: 'Allegro' },
        }),
      );
      await renderDialog();
      await act(async () => {
        fireEvent.click(screen.getAllByRole('button', { name: 'Link to this transaction' })[1]);
      });
      await act(async () => {});
      expect(api.link).toHaveBeenCalledWith('r-1', 'tx-b');
      expect(toast.success).toHaveBeenCalledWith('Email linked to the transaction');
      expect(onChanged).toHaveBeenCalledTimes(1);
      expect(screen.getByText('Waiting for approval')).toBeInTheDocument();
      expect(screen.getByText('Your choice')).toBeInTheDocument();
    });

    it('names a refusal and stays on the candidates', async () => {
      api.get.mockResolvedValue(ambiguous());
      api.link.mockRejectedValue({ response: { data: { message: 'That transaction is a transfer' } } });
      await renderDialog();
      await act(async () => {
        fireEvent.click(screen.getAllByRole('button', { name: 'Link to this transaction' })[0]);
      });
      await act(async () => {});
      expect(screen.getByRole('alert')).toHaveTextContent('That transaction is a transfer');
      expect(onChanged).not.toHaveBeenCalled();
      expect(screen.getAllByRole('button', { name: 'Link to this transaction' })).toHaveLength(2);
    });

    it('offers no link for an email whose proposal was already applied', async () => {
      api.get.mockResolvedValue(
        makeDetail({ status: 'review', displayState: 'applied', candidates: [candidate('tx-a', -25)] }),
      );
      await renderDialog();
      expect(screen.getByText('Transactions that fit')).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Link to this transaction' })).not.toBeInTheDocument();
    });

    it('shows no candidate section when there are none', async () => {
      await renderDialog();
      expect(screen.queryByText('Transactions that fit')).not.toBeInTheDocument();
    });
  });

  describe('choosing a transaction by hand', () => {
    it.each(['unmatched', 'no_parser', 'parse_failed'] as const)('offers the picker for a %s email', async (status) => {
      api.get.mockResolvedValue(makeDetail({ status }));
      await renderDialog();
      expect(screen.getByText('Choose the transaction')).toBeInTheDocument();
      expect(txApi.getAll).toHaveBeenCalledWith({ startDate: '2026-08-29', endDate: '2026-09-15', limit: 50 });
    });

    it.each([
      ['ambiguous', null],
      ['review', 'proposed'],
      ['ignored', null],
      ['skipped', null],
      ['pending', null],
    ] as const)('does not offer it for a %s email', async (status, displayState) => {
      api.get.mockResolvedValue(makeDetail({ status, displayState }));
      await renderDialog();
      expect(screen.queryByText('Choose the transaction')).not.toBeInTheDocument();
      expect(txApi.getAll).not.toHaveBeenCalled();
    });

    it('links the email to the chosen transaction and shows the updated email', async () => {
      api.get.mockResolvedValue(makeDetail({ status: 'unmatched' }));
      api.link.mockResolvedValue(makeDetail({ status: 'review', displayState: 'proposed', matchKind: 'manual' }));
      await renderDialog();
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Link' }));
      });
      await act(async () => {});
      expect(api.link).toHaveBeenCalledWith('r-1', 'tx-p');
      expect(toast.success).toHaveBeenCalledWith('Email linked to the transaction');
      expect(onChanged).toHaveBeenCalledTimes(1);
      expect(screen.getByText('Waiting for approval')).toBeInTheDocument();
      expect(screen.queryByText('Choose the transaction')).not.toBeInTheDocument();
    });

    it('shows the server refusal and keeps the picker', async () => {
      api.get.mockResolvedValue(makeDetail({ status: 'unmatched' }));
      api.link.mockRejectedValue({ response: { data: { message: 'A transfer cannot be linked' } } });
      await renderDialog();
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Link' }));
      });
      await act(async () => {});
      expect(screen.getByRole('alert')).toHaveTextContent('A transfer cannot be linked');
      expect(onChanged).not.toHaveBeenCalled();
      expect(screen.getByRole('button', { name: 'Link' })).toBeEnabled();
    });
  });

  it('shows a failed load as an error with a retry', async () => {
    api.get.mockRejectedValueOnce(new Error('boom'));
    await renderDialog();
    expect(screen.getByRole('alert')).toHaveTextContent('The email could not be loaded');
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    });
    await act(async () => {});
    expect(api.get).toHaveBeenCalledTimes(2);
    expect(screen.getByText('Your order 123')).toBeInTheDocument();
  });

  it('closes', async () => {
    await renderDialog();
    await act(async () => {
      fireEvent.click(screen.getAllByRole('button', { name: 'Close' }).at(-1) as HTMLElement);
    });
    expect(onClose).toHaveBeenCalled();
  });
});

describe('EmailReceiptDetailDialog linked receipts', () => {
  const onOpenReceipt = vi.fn();

  async function renderLinked(detail: ReturnType<typeof makeDetail>, withOpen = true) {
    api.get.mockResolvedValue(detail);
    await act(async () => {
      render(
        <EmailReceiptDetailDialog
          receiptId="r-1"
          categoryLabels={labels}
          onClose={onClose}
          onChanged={onChanged}
          {...(withOpen ? { onOpenReceipt } : {})}
        />,
      );
    });
    await act(async () => {});
  }

  beforeEach(() => {
    vi.clearAllMocks();
    accountsApi.getAll.mockResolvedValue([]);
  });

  it('lists the purchase emails a settlement joined and opens one in the same dialog', async () => {
    await renderLinked(
      makeDetail({
        linkedComponents: [
          { partIndex: 0, receiptId: 'c-1', subject: 'Order A', effectiveDate: '2026-08-01T10:00:00.000Z' },
          { partIndex: 1, receiptId: 'c-2', subject: 'Order B', effectiveDate: '2026-08-02T10:00:00.000Z' },
        ],
      }),
    );
    const section = screen.getByRole('region', { name: 'Linked purchase emails' });
    expect(within(section).getAllByRole('listitem')).toHaveLength(2);
    expect(within(section).getByText(/Part 1: Order A/)).toBeInTheDocument();
    expect(within(section).getByText(/Part 2: Order B/)).toBeInTheDocument();
    fireEvent.click(within(section).getByRole('button', { name: 'Open the email Order B' }));
    expect(onOpenReceipt).toHaveBeenCalledWith('c-2');
  });

  it('lists the settlements that paid a component with the part amount and what the join did', async () => {
    await renderLinked(
      makeDetail({
        status: 'component',
        linkKey: 'KEY-1',
        linkedSettlements: [
          {
            receiptId: 's-1',
            subject: 'Card statement',
            effectiveDate: '2026-09-01T10:00:00.000Z',
            partAmount: 12.5,
            outcome: 'joined',
            transactionId: null,
          },
        ],
      }),
    );
    const section = screen.getByRole('region', { name: 'Paid by' });
    expect(within(section).getByText(/Card statement/)).toHaveTextContent('12.50');
    expect(within(section).getByText('Replaced by the lines of the purchase email.')).toBeInTheDocument();
    fireEvent.click(within(section).getByRole('button', { name: 'Open the email Card statement' }));
    expect(onOpenReceipt).toHaveBeenCalledWith('s-1');
  });

  it('names the email that already enriched the candidate and opens it', async () => {
    await renderLinked(
      makeDetail({
        status: 'review_conflict',
        statusReason: 'enriched_by_other',
        candidates: [candidate('tx-1', -25)],
        enrichedBy: { receiptId: 'e-1', subject: 'Earlier order' },
      }),
    );
    expect(screen.getByText('Already enriched by: Earlier order')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Link to this transaction' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Open the email Earlier order' }));
    expect(onOpenReceipt).toHaveBeenCalledWith('e-1');
  });

  it('shows no linked section and no enrichment line for an ordinary email', async () => {
    await renderLinked(makeDetail({ enrichedBy: { receiptId: 'e-1', subject: 'Stray' } }));
    expect(screen.queryByRole('region', { name: 'Linked purchase emails' })).not.toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Paid by' })).not.toBeInTheDocument();
    expect(screen.queryByText(/Already enriched by/)).not.toBeInTheDocument();
  });

  it('names the linked email without a button when the dialog cannot open another', async () => {
    await renderLinked(
      makeDetail({
        linkedComponents: [{ partIndex: 0, receiptId: 'c-1', subject: 'Order A', effectiveDate: '2026-08-01T10:00:00.000Z' }],
      }),
      false,
    );
    expect(screen.getByText(/Part 1: Order A/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Open the email Order A' })).not.toBeInTheDocument();
  });
});
