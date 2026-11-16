import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import toast from 'react-hot-toast';
import { AxiosError } from 'axios';
import { render, screen, fireEvent, within, act } from '@/test/render';
import { AiReviewInbox } from './AiReviewInbox';
import { makeReviewItem, makeTradeItem, PROPOSED_ACTION, TRADE_ACTION } from './ai-review-fixtures';
import type { AiReviewItem } from '@/types/ai-review';
import { useDensityStore } from '@/store/densityStore';

const api = vi.hoisted(() => ({ list: vi.fn(), dismiss: vi.fn(), approveBatch: vi.fn() }));
const nav = vi.hoisted(() => ({ search: '', replace: vi.fn() }));
const confirmAction = vi.hoisted(() => vi.fn());
const clearAllCache = vi.hoisted(() => vi.fn());
const notifyAiAction = vi.hoisted(() => vi.fn());

vi.mock('@/lib/ai-review-api', () => ({ aiReviewApi: api }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: nav.replace, back: vi.fn(), prefetch: vi.fn(), refresh: vi.fn() }),
  usePathname: () => '/ai-reviews',
  useSearchParams: () => new URLSearchParams(nav.search),
}));
vi.mock('@/lib/ai', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/ai')>()),
  aiApi: { confirmAction },
}));
vi.mock('@/lib/apiCache', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/apiCache')>()),
  clearAllCache,
}));
vi.mock('@/lib/aiActionSignal', () => ({ notifyAiAction }));
vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() }),
}));

const proposed = makeReviewItem({
  id: 'req-p',
  status: 'proposed',
  proposal: { action: PROPOSED_ACTION },
});

function conflict() {
  return new AxiosError('conflict', '409', undefined, undefined, {
    status: 409,
    data: { message: 'no longer open' },
  } as never);
}

async function renderInbox() {
  let result!: ReturnType<typeof render>;
  await act(async () => {
    result = render(<AiReviewInbox />);
  });
  return result;
}

async function click(element: HTMLElement) {
  await act(async () => {
    fireEvent.click(element);
  });
  await act(async () => {});
}

describe('AiReviewInbox', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    nav.search = '';
    api.list.mockResolvedValue([]);
  });

  it('lists a request with its transaction, rule, instruction, status and link', async () => {
    api.list.mockResolvedValue([makeReviewItem()]);
    await renderInbox();
    expect(api.list).toHaveBeenCalledWith('open');
    expect(screen.getByText('Allegro')).toBeInTheDocument();
    expect(screen.getByText(/25\.00/)).toBeInTheDocument();
    expect(screen.getByText('Rule: Allegro orders')).toBeInTheDocument();
    expect(screen.getByText('Split this purchase by the items in the order')).toBeInTheDocument();
    expect(screen.getByText('Pending', { selector: 'span' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'View transaction' })).toHaveAttribute(
      'href',
      '/transactions?targetTransactionId=tx-1',
    );
  });

  it.each([
    ['claimed', 'In review'],
    ['applied', 'Applied'],
    ['rejected', 'Rejected'],
    ['expired', 'Expired'],
  ] as const)('shows a %s request with its badge and no Dismiss', async (status, label) => {
    api.list.mockResolvedValue([makeReviewItem({ status })]);
    await renderInbox();
    expect(screen.getByText(label, { selector: 'span' })).toBeInTheDocument();
    const dismissible = status === 'claimed';
    expect(screen.queryByRole('button', { name: 'Dismiss' }) !== null).toBe(dismissible);
  });

  it('asks the server for the chosen status', async () => {
    await renderInbox();
    await click(screen.getByRole('button', { name: 'Applied' }));
    expect(api.list).toHaveBeenLastCalledWith('applied');
    expect(screen.getByRole('button', { name: 'Applied' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByText('No requests with this status')).toBeInTheDocument();
  });

  it('explains where requests come from when the inbox is empty', async () => {
    await renderInbox();
    expect(screen.getByText('No review requests')).toBeInTheDocument();
    expect(screen.getByText(/rule with the Ask for an AI review action/)).toBeInTheDocument();
    expect(screen.getByText(/MCP client such as the relay agent/)).toBeInTheDocument();
  });

  it('keeps the tour anchor on the inbox while it is empty', async () => {
    const { container } = await renderInbox();
    expect(container.querySelectorAll('[data-tour-id="ai-review-inbox"]')).toHaveLength(1);
    expect(screen.getByText('No review requests')).toBeInTheDocument();
  });

  it('shows an error, not an empty list, when the load fails, and retries', async () => {
    api.list.mockRejectedValueOnce(new Error('boom'));
    await renderInbox();
    expect(screen.getByRole('alert')).toHaveTextContent('Could not load the review requests');
    expect(screen.queryByText('No review requests')).not.toBeInTheDocument();

    api.list.mockResolvedValue([makeReviewItem()]);
    await click(screen.getByRole('button', { name: 'Try again' }));
    expect(screen.getByText('Allegro')).toBeInTheDocument();
  });

  it('shows the proposal as the confirmation card, split lines included', async () => {
    api.list.mockResolvedValue([proposed]);
    await renderInbox();
    expect(screen.getByText('Groceries: -$15.00 (Milk)')).toBeInTheDocument();
    expect(screen.getByText('Household: -$10.00 (Soap)')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Approve' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Dismiss' })).toBeInTheDocument();
  });

  it('approves through the chat confirm client, invalidates caches and marks the row applied', async () => {
    api.list.mockResolvedValue([proposed]);
    confirmAction.mockResolvedValue({ type: 'update_transaction', id: 'tx-1' });
    await renderInbox();
    await click(screen.getByRole('button', { name: 'Approve' }));

    expect(confirmAction).toHaveBeenCalledWith({
      actionId: 'act-1',
      signature: 'sig-1',
      descriptor: { transactionId: 'tx-1' },
    });
    expect(clearAllCache).toHaveBeenCalledTimes(1);
    expect(notifyAiAction).toHaveBeenCalledTimes(1);
    expect(toast.success).toHaveBeenCalledWith('Proposal applied');
    expect(screen.getByText('Applied', { selector: 'span' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Approve' })).not.toBeInTheDocument();
  });

  it('caches are untouched and the card offers a retry when the confirm fails', async () => {
    api.list.mockResolvedValue([proposed]);
    confirmAction.mockRejectedValue(new Error('server down'));
    await renderInbox();
    await click(screen.getByRole('button', { name: 'Approve' }));
    expect(clearAllCache).not.toHaveBeenCalled();
    expect(screen.getByText('server down')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
  });

  it('on a 409 shows the server\'s reason and reloads the list', async () => {
    api.list.mockResolvedValueOnce([proposed]).mockResolvedValue([{ ...proposed, status: 'rejected', proposal: undefined }]);
    confirmAction.mockRejectedValue(conflict());
    await renderInbox();
    await click(screen.getByRole('button', { name: 'Approve' }));

    expect(toast.error).toHaveBeenCalledWith('no longer open');
    expect(api.list).toHaveBeenCalledTimes(2);
    expect(clearAllCache).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: 'Approve' })).not.toBeInTheDocument();
    expect(screen.getByText('Rejected', { selector: 'span' })).toBeInTheDocument();
  });

  it('on a 409 with no message of its own says the request changed', async () => {
    api.list.mockResolvedValueOnce([proposed]).mockResolvedValue([]);
    confirmAction.mockRejectedValue(
      new AxiosError('conflict', '409', undefined, undefined, { status: 409, data: {} } as never),
    );
    await renderInbox();
    await click(screen.getByRole('button', { name: 'Approve' }));
    expect(toast.error).toHaveBeenCalledWith('This request changed in the meantime. The list was reloaded.');
    expect(api.list).toHaveBeenCalledTimes(2);
  });

  it('shows a proposal that no longer fits as an error with Dismiss only', async () => {
    const stale: AiReviewItem = makeReviewItem({
      status: 'proposed',
      proposal: { error: 'The split lines no longer add up to the amount' },
    });
    api.list.mockResolvedValue([stale]);
    await renderInbox();
    expect(screen.getByRole('alert')).toHaveTextContent('The split lines no longer add up to the amount');
    expect(screen.queryByRole('button', { name: 'Approve' })).not.toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'Dismiss' })).toHaveLength(1);
  });

  it('dismisses a pending request only after the confirmation dialog', async () => {
    api.list.mockResolvedValueOnce([makeReviewItem()]).mockResolvedValue([]);
    api.dismiss.mockResolvedValue(makeReviewItem({ status: 'rejected' }));
    await renderInbox();
    await click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(api.dismiss).not.toHaveBeenCalled();

    const dialog = screen.getByRole('dialog');
    await click(within(dialog).getByRole('button', { name: 'Dismiss request' }));
    expect(api.dismiss).toHaveBeenCalledWith('req-1');
    expect(toast.success).toHaveBeenCalledWith('Request dismissed');
    expect(api.list).toHaveBeenCalledTimes(2);
  });

  it('dismisses a proposed request from the card', async () => {
    api.list.mockResolvedValue([proposed]);
    api.dismiss.mockResolvedValue(makeReviewItem({ status: 'rejected' }));
    await renderInbox();
    await click(screen.getByRole('button', { name: 'Dismiss' }));
    await click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Dismiss request' }));
    expect(api.dismiss).toHaveBeenCalledWith('req-p');
  });

  it('keeps the request when the dialog is cancelled', async () => {
    api.list.mockResolvedValue([makeReviewItem()]);
    await renderInbox();
    await click(screen.getByRole('button', { name: 'Dismiss' }));
    await click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Cancel' }));
    expect(api.dismiss).not.toHaveBeenCalled();
  });

  it('on a 409 from dismiss says the request changed and reloads', async () => {
    api.list.mockResolvedValue([makeReviewItem()]);
    api.dismiss.mockRejectedValue(conflict());
    await renderInbox();
    await click(screen.getByRole('button', { name: 'Dismiss' }));
    await click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Dismiss request' }));
    expect(toast.error).toHaveBeenCalledWith('This request changed in the meantime. The list was reloaded.');
    expect(api.list).toHaveBeenCalledTimes(2);
  });

  it('says so when the transaction no longer exists', async () => {
    api.list.mockResolvedValue([makeReviewItem({ transaction: null })]);
    await renderInbox();
    expect(screen.getByText('This transaction no longer exists')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'View transaction' })).not.toBeInTheDocument();
  });

  describe('a profile draft request among the others', () => {
    const draft = (over: Partial<AiReviewItem> = {}) =>
      makeReviewItem({
        id: 'req-draft',
        kind: 'email_parser_draft',
        ruleId: null,
        ruleName: null,
        transactionId: null,
        transaction: null,
        parserDraft: { domain: 'shop.example.com', emailCount: 2, parserId: null },
        ...over,
      });

    it('lists it with an ordinary request, each in its own shape', async () => {
      api.list.mockResolvedValue([draft(), makeReviewItem()]);
      await renderInbox();
      expect(screen.getByText('Profile draft from 2 emails (shop.example.com)')).toBeInTheDocument();
      expect(screen.getByText('Rule: Allegro orders')).toBeInTheDocument();
    });

    it('dismisses it after the confirmation dialog, like any other request', async () => {
      api.list.mockResolvedValueOnce([draft()]).mockResolvedValue([]);
      api.dismiss.mockResolvedValue(draft({ status: 'rejected' }));
      await renderInbox();
      await click(screen.getByRole('button', { name: 'Dismiss' }));
      await click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Dismiss request' }));
      expect(api.dismiss).toHaveBeenCalledWith('req-draft');
      expect(toast.success).toHaveBeenCalledWith('Request dismissed');
    });

    it('points a proposed one at the profile settings and offers no approve button here', async () => {
      api.list.mockResolvedValue([draft({ status: 'proposed', parserDraft: { domain: 'shop.example.com', emailCount: 2, parserId: 'p-1' } })]);
      await renderInbox();
      expect(screen.getByRole('link', { name: 'Test and approve it in the profile settings' })).toHaveAttribute(
        'href',
        '/email-receipts?tab=profiles',
      );
      expect(screen.queryByRole('button', { name: /Approve|Confirm|Apply/ })).not.toBeInTheDocument();
      expect(confirmAction).not.toHaveBeenCalled();
    });
  });
  describe('kind filter and bulk approval', () => {
    const receipt = (id: string, over: Partial<AiReviewItem> = {}) =>
      makeReviewItem({
        id,
        kind: 'email_receipt',
        ruleId: null,
        ruleName: null,
        status: 'proposed',
        proposal: { action: { ...PROPOSED_ACTION, actionId: `act-${id}` } },
        emailReceipt: {
          id: `er-${id}`,
          subject: `Order ${id}`,
          fromAddress: 'shop@example.com',
          forwardedBy: null,
          receivedAt: '2026-09-01T10:00:00.000Z',
        },
        ...over,
      });

    it('narrows the loaded list to one kind and writes it to the URL', async () => {
      api.list.mockResolvedValue([receipt('r1'), makeReviewItem({ id: 'rule-1' })]);
      await renderInbox();
      expect(screen.getByText('Rule: Allegro orders')).toBeInTheDocument();
      await click(screen.getByRole('button', { name: /^Email receipts/ }));
      expect(screen.queryByText('Rule: Allegro orders')).not.toBeInTheDocument();
      expect(screen.getByRole('button', { name: /^Email receipts/ })).toHaveAttribute('aria-pressed', 'true');
      expect(nav.replace).toHaveBeenLastCalledWith('/ai-reviews?kind=email_receipt', { scroll: false });
      await click(screen.getByRole('button', { name: /^All( \(\d+\))?$/ }));
      expect(nav.replace).toHaveBeenLastCalledWith('/ai-reviews', { scroll: false });
      expect(api.list).toHaveBeenCalledTimes(1);
    });

    it('counts the loaded rows each kind segment shows, a trade confirmation under Email receipts', async () => {
      api.list.mockResolvedValue([receipt('r1'), makeTradeItem({ id: 'trade-1' }), makeReviewItem({ id: 'rule-1' })]);
      await renderInbox();
      const kinds = within(screen.getByRole('group', { name: 'Filter by kind' }));
      expect(kinds.getAllByRole('button').map((b) => b.textContent)).toEqual(['All (3)', 'Email receipts (2)', 'Rules (1)']);
    });

    it('prints no kind count while the list is loading', async () => {
      api.list.mockReturnValue(new Promise(() => {}));
      await renderInbox();
      const kinds = within(screen.getByRole('group', { name: 'Filter by kind' }));
      expect(kinds.getAllByRole('button').map((b) => b.textContent)).toEqual(['All', 'Email receipts', 'Rules']);
    });

    it('lists a trade confirmation under Email receipts, not under transaction reviews', async () => {
      api.list.mockResolvedValue([makeTradeItem({ proposal: { action: TRADE_ACTION } }), makeReviewItem({ id: 'rule-1' })]);
      await renderInbox();
      await click(screen.getByRole('button', { name: /^Email receipts/ }));
      expect(screen.getByText('Buy 75.9878 shares of XCNS')).toBeInTheDocument();
      // Its card is the investment one the backend builds, not a bank transaction's.
      expect(screen.getByText('Create this investment transaction?')).toBeInTheDocument();
      expect(screen.queryByText('Rule: Allegro orders')).not.toBeInTheDocument();
      await click(screen.getByRole('button', { name: /^All( \(\d+\))?$/ }));
      expect(screen.getByText('Buy 75.9878 shares of XCNS')).toBeInTheDocument();
    });

    it('starts from ?kind= and ignores a value that is no kind', async () => {
      nav.search = 'kind=email_receipt';
      api.list.mockResolvedValue([receipt('r1'), makeReviewItem({ id: 'rule-1' })]);
      await renderInbox();
      expect(screen.queryByText('Rule: Allegro orders')).not.toBeInTheDocument();
      expect(screen.getByRole('button', { name: /^Email receipts/ })).toHaveAttribute('aria-pressed', 'true');
    });

    it('offers no selection when nothing can be approved or sent', async () => {
      api.list.mockResolvedValue([makeReviewItem({ status: 'applied' })]);
      await renderInbox();
      expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /Approve selected/ })).not.toBeInTheDocument();
    });

    it('approves the selected proposals after one confirmation and reports the result', async () => {
      api.list.mockResolvedValue([receipt('r1'), receipt('r2'), makeReviewItem({ id: 'pending-1' })]);
      api.approveBatch.mockResolvedValue({
        results: [{ id: 'r1', ok: true }],
        approved: 1,
        failed: 0,
      });
      await renderInbox();
      expect(screen.getByRole('button', { name: 'Approve selected (0)' })).toBeDisabled();
      await click(screen.getByRole('checkbox', { name: 'Select Order r1' }));
      expect(screen.getByRole('button', { name: 'Approve selected (1)' })).toBeEnabled();
      await click(screen.getByRole('button', { name: 'Approve selected (1)' }));
      expect(api.approveBatch).not.toHaveBeenCalled();
      await click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Apply 1 proposal' }));

      expect(api.approveBatch).toHaveBeenCalledWith(['r1']);
      expect(clearAllCache).toHaveBeenCalledTimes(1);
      expect(notifyAiAction).toHaveBeenCalledTimes(1);
      expect(screen.getByRole('status')).toHaveTextContent('1 proposal applied, 0 not applied.');
      // The list is read again after the bulk approval.
      expect(api.list).toHaveBeenCalledTimes(2);
    });

    it('approves everything shown, in chunks, and lists why a request was not applied', async () => {
      const many = Array.from({ length: 101 }, (_, i) => receipt(`r${i}`));
      api.list.mockResolvedValue(many);
      api.approveBatch
        .mockResolvedValueOnce({
          results: many.slice(0, 100).map((item) => ({ id: item.id, ok: true })),
          approved: 100,
          failed: 0,
        })
        .mockResolvedValueOnce({
          results: [{ id: 'r100', ok: false, error: 'The transaction changed' }],
          approved: 0,
          failed: 1,
        });
      await renderInbox();
      await click(screen.getByRole('button', { name: 'Approve all shown (101)' }));
      await click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Apply 101 proposals' }));

      expect(api.approveBatch).toHaveBeenCalledTimes(2);
      expect(api.approveBatch.mock.calls[0][0]).toHaveLength(100);
      expect(api.approveBatch.mock.calls[1][0]).toEqual(['r100']);
      expect(screen.getByRole('status')).toHaveTextContent('100 proposals applied, 1 not applied.');
      expect(screen.getByText(/The transaction changed/)).toBeInTheDocument();
    });

    it('selects every approvable row with the header checkbox', async () => {
      api.list.mockResolvedValue([receipt('r1'), receipt('r2')]);
      await renderInbox();
      await click(screen.getByRole('checkbox', { name: 'Select all requests shown that can be approved or sent' }));
      expect(screen.getByRole('button', { name: 'Approve selected (2)' })).toBeEnabled();
      await click(screen.getByRole('checkbox', { name: 'Select all requests shown that can be approved or sent' }));
      expect(screen.getByRole('button', { name: 'Approve selected (0)' })).toBeDisabled();
    });

    it('offers a checkbox on a pending row that picks what goes to the assistant, not what is approved', async () => {
      api.list.mockResolvedValue([receipt('r1'), makeReviewItem({ id: 'p1', status: 'pending' })]);
      await renderInbox();
      expect(screen.getByRole('button', { name: 'Send 1 pending request to the AI assistant' })).toBeInTheDocument();
      const boxes = screen.getAllByRole('checkbox');
      // The header and one per row: the proposal and the pending request.
      expect(boxes).toHaveLength(3);
      await click(boxes[2]);
      expect(screen.getByRole('button', { name: 'Send 1 selected request to the AI assistant' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Approve selected (0)' })).toBeDisabled();
    });

    it('does not approve anything when the confirmation is cancelled', async () => {
      api.list.mockResolvedValue([receipt('r1')]);
      await renderInbox();
      await click(screen.getByRole('button', { name: 'Approve all shown (1)' }));
      await click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Cancel' }));
      expect(api.approveBatch).not.toHaveBeenCalled();
    });

    it('names a failed bulk call, applies nothing locally and still reloads the list', async () => {
      api.list.mockResolvedValue([receipt('r1')]);
      api.approveBatch.mockRejectedValue(new Error('server down'));
      await renderInbox();
      await click(screen.getByRole('button', { name: 'Approve all shown (1)' }));
      await click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Apply 1 proposal' }));
      expect(toast.error).toHaveBeenCalled();
      expect(clearAllCache).not.toHaveBeenCalled();
      expect(screen.queryByRole('status')).not.toBeInTheDocument();
      expect(api.list).toHaveBeenCalledTimes(2);
    });
  });

  describe('density and the phone layout', () => {
    const PHONE_QUERY = '(max-width: 639px)';
    const originalMatchMedia = window.matchMedia;
    const setPhoneViewport = (isPhone: boolean) => {
      window.matchMedia = vi.fn().mockImplementation((query: string) => ({
        matches: isPhone && query === PHONE_QUERY,
        media: query,
        onchange: null,
        addListener: vi.fn(),
        removeListener: vi.fn(),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        dispatchEvent: vi.fn(),
      })) as unknown as typeof window.matchMedia;
    };
    const firstRowCells = (container: HTMLElement) => container.querySelector('tbody tr')?.querySelectorAll('td') ?? [];

    beforeEach(() => {
      localStorage.clear();
      useDensityStore.setState({ densities: {} });
      api.list.mockResolvedValue([makeReviewItem({ status: 'applied' })]);
    });
    afterEach(() => {
      window.matchMedia = originalMatchMedia;
    });

    it('offers the density toggle above the list and remembers the level for the inbox', async () => {
      await renderInbox();
      await click(screen.getByTitle('Toggle row density'));
      expect(useDensityStore.getState().densities.aiReviews).toBe('compact');
    });

    it('draws a request as one card cell on a phone at Normal density, with its date, amount and status', async () => {
      setPhoneViewport(true);
      const { container } = await renderInbox();
      const cells = firstRowCells(container);
      expect(cells).toHaveLength(1);
      expect(cells[0]).toHaveTextContent('Allegro');
      expect(cells[0]).toHaveTextContent(/25\.00/);
      expect(cells[0]).toHaveTextContent('Applied');
      expect(screen.queryByRole('columnheader', { name: 'Amount' })).not.toBeInTheDocument();
    });

    it('keeps the four columns on a phone at Compact density, and on a wide screen', async () => {
      setPhoneViewport(true);
      useDensityStore.setState({ densities: { aiReviews: 'compact' } });
      const { container, unmount } = await renderInbox();
      expect(firstRowCells(container)).toHaveLength(4);
      unmount();
      setPhoneViewport(false);
      useDensityStore.setState({ densities: {} });
      const wide = await renderInbox();
      expect(firstRowCells(wide.container)).toHaveLength(4);
      expect(screen.getByRole('columnheader', { name: 'Amount' })).toBeInTheDocument();
    });
  });
});
