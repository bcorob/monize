import { describe, it, expect, vi, beforeEach } from 'vitest';
import toast from 'react-hot-toast';
import { useRouter } from 'next/navigation';
import { render, screen, fireEvent, act, within } from '@/test/render';
import { EmailReceiptsManager } from './EmailReceiptsManager';
import { makeDetail, makeMailbox, makeReceipt } from './email-receipts-fixtures';
import { peekChatHandoff } from '@/lib/ai-chat-handoff';

const api = vi.hoisted(() => ({
  list: vi.fn(),
  get: vi.fn(),
  mailboxGet: vi.fn(),
  draftWithAi: vi.fn(),
  reprocess: vi.fn(),
}));
const assistant = vi.hoisted(() => ({ canAnswer: vi.fn() }));

vi.mock('@/lib/email-receipts-api', () => ({
  emailReceiptsApi: {
    receipts: { list: api.list, get: api.get, reprocess: api.reprocess },
    mailbox: { get: api.mailboxGet },
    parsers: { draftWithAi: api.draftWithAi },
  },
}));
vi.mock('@/lib/assistant-ready', () => ({ assistantCanAnswerNow: assistant.canAnswer }));
vi.mock('@/hooks/useReceiptParserLookups', () => ({
  useReceiptParserLookups: () => ({ state: { status: 'loading' }, reload: vi.fn() }),
}));
vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() }),
}));

const shop = (n: number, over: Record<string, unknown> = {}) =>
  makeReceipt({
    id: `r-${n}`,
    subject: `Order ${n}`,
    status: 'no_parser',
    fromAddress: 'orders@shop.example.com',
    fromDomain: 'shop.example.com',
    ...over,
  });

const other = { fromAddress: 'news@other.example.org', fromDomain: 'other.example.org' };

const six = [1, 2, 3, 4, 5, 6].map((n) => shop(n));

async function renderManager() {
  await act(async () => {
    render(<EmailReceiptsManager />);
  });
  await act(async () => {});
}

async function click(element: HTMLElement) {
  await act(async () => {
    fireEvent.click(element);
  });
  await act(async () => {});
}

const checkbox = (subject: string) => screen.getByRole('checkbox', { name: `Select ${subject}` });
const bar = () => screen.queryByRole('region', { name: 'Selected emails' });
const draftButton = (count: number) => screen.getByRole('button', { name: `Prepare a profile with AI (${count})` });

describe('EmailReceiptsManager: drafting a profile with AI from selected emails', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    assistant.canAnswer.mockResolvedValue(true);
    api.list.mockResolvedValue(six);
    api.mailboxGet.mockResolvedValue(makeMailbox());
    api.draftWithAi.mockResolvedValue({ ok: true, requestId: 'req-draft' });
    api.get.mockImplementation(async (id: string) =>
      makeDetail({
        id,
        subject: `Order ${id.slice(2)}`,
        fromAddress: 'orders@shop.example.com',
        fromDomain: 'shop.example.com',
        bodyText: `Widget ${id} 12.00`,
        effectiveDate: '2026-08-10T08:15:00.000Z',
        forwardedBy: 'alice.example@gmail.example.com',
      }),
    );
  });

  describe('the selection', () => {
    it('puts a labelled checkbox on every email and no bar until one is ticked', async () => {
      await renderManager();
      for (const n of [1, 2, 3, 4, 5, 6]) expect(checkbox(`Order ${n}`)).not.toBeChecked();
      expect(bar()).not.toBeInTheDocument();
    });

    it('shows the selection bar with the count and a Prepare a profile with AI (N) button', async () => {
      await renderManager();
      await click(checkbox('Order 1'));
      await click(checkbox('Order 3'));

      expect(bar()).toHaveTextContent('2 emails selected');
      expect(draftButton(2)).toBeEnabled();
    });

    it('says one email when one is ticked', async () => {
      await renderManager();
      await click(checkbox('Order 1'));
      expect(bar()).toHaveTextContent('1 email selected');
    });

    it('does not stop at five: every email can be selected, the draft button is the one that is limited', async () => {
      await renderManager();
      for (const n of [1, 2, 3, 4, 5, 6]) await click(checkbox(`Order ${n}`));

      expect(checkbox('Order 6')).toBeEnabled();
      expect(bar()).toHaveTextContent('6 emails selected');
      const button = draftButton(6);
      expect(button).toBeDisabled();
      expect(within(bar() as HTMLElement).getByText(/At most 5 emails from one sender/)).toBeInTheDocument();
      await click(checkbox('Order 6'));
      expect(draftButton(5)).toBeEnabled();
    });

    it('points the disabled draft button at the sentence that says why', async () => {
      await renderManager();
      for (const n of [1, 2, 3, 4, 5, 6]) await click(checkbox(`Order ${n}`));

      const reason = within(bar() as HTMLElement).getByText(/At most 5 emails from one sender/);
      expect(draftButton(6)).toHaveAccessibleDescription(reason.textContent as string);
    });

    it('lets a skipped email be selected but keeps it out of a draft, saying why', async () => {
      api.list.mockResolvedValue([shop(1), shop(2, { status: 'skipped' })]);
      await renderManager();
      expect(checkbox('Order 2')).toBeEnabled();
      await click(checkbox('Order 2'));
      expect(draftButton(1)).toBeDisabled();
      expect(within(bar() as HTMLElement).getByText(/could not be read has no text/)).toBeInTheDocument();
    });

    it('keeps the draft button on for emails of two senders (the dialog asks first)', async () => {
      api.list.mockResolvedValue([shop(1), shop(2, other)]);
      await renderManager();
      await click(checkbox('Order 1'));
      await click(checkbox('Order 2'));

      expect(draftButton(2)).toBeEnabled();
      expect(within(bar() as HTMLElement).queryByText(/At most/)).not.toBeInTheDocument();
      // Delete and Ignore do not care about the sender.
      expect(screen.getByRole('button', { name: 'Delete (2)' })).toBeEnabled();
    });

    it('turns the draft button off, naming the limit, above five emails of one sender even beside another sender', async () => {
      api.list.mockResolvedValue([...six, shop(7, other)]);
      await renderManager();
      for (const n of [1, 2, 3, 4, 5, 6, 7]) await click(checkbox(`Order ${n}`));
      expect(draftButton(7)).toBeDisabled();
      expect(within(bar() as HTMLElement).getByText(/At most 5 emails from one sender/)).toBeInTheDocument();
    });

    it('turns the draft button off above five senders, naming the limit', async () => {
      const senders = [1, 2, 3, 4, 5, 6].map((n) =>
        shop(n, { fromAddress: `a@d${n}.example.org`, fromDomain: `d${n}.example.org` }),
      );
      api.list.mockResolvedValue(senders);
      await renderManager();
      for (const n of [1, 2, 3, 4, 5, 6]) await click(checkbox(`Order ${n}`));
      expect(draftButton(6)).toBeDisabled();
      expect(within(bar() as HTMLElement).getByText(/At most 5 senders can be used together/)).toBeInTheDocument();
    });

    it('turns the draft button off for trade confirmations of two senders', async () => {
      api.list.mockResolvedValue([shop(1, { isTrade: true }), shop(2, { ...other, isTrade: true })]);
      await renderManager();
      await click(checkbox('Order 1'));
      await click(checkbox('Order 2'));
      expect(draftButton(2)).toBeDisabled();
      expect(within(bar() as HTMLElement).getByText(/A trade profile reads the emails of one sender/)).toBeInTheDocument();
    });

    it('clears the selection from the bar', async () => {
      await renderManager();
      await click(checkbox('Order 1'));
      await click(screen.getByRole('button', { name: 'Clear selection' }));
      expect(bar()).not.toBeInTheDocument();
      expect(checkbox('Order 1')).not.toBeChecked();
    });

    it('keeps the ticked emails when the state filter changes', async () => {
      await renderManager();
      await click(checkbox('Order 1'));
      api.list.mockResolvedValueOnce([shop(1), shop(2)]);
      await click(screen.getByRole('button', { name: 'No profile' }));
      expect(bar()).toHaveTextContent('1 email selected');
      expect(checkbox('Order 1')).toBeChecked();
    });

    it('keeps an email a reload no longer lists in the selection, and says it is not shown', async () => {
      api.reprocess.mockResolvedValue(makeDetail());
      await renderManager();
      await click(checkbox('Order 1'));
      await click(checkbox('Order 2'));
      // An action on another email reloads the list; email 1 is gone from it.
      api.list.mockResolvedValueOnce([shop(2), shop(3)]);
      const row = screen.getByRole('row', { name: /Order 3/ });
      await click(within(row).getByRole('button', { name: 'More actions' }));
      await click(screen.getByRole('menuitem', { name: 'Reprocess' }));

      expect(bar()).toHaveTextContent('2 emails selected');
      expect(bar()).toHaveTextContent('1 of the selected emails is not shown in this list.');
      expect(checkbox('Order 2')).toBeChecked();
    });
  });

  describe('drafting from the selection', () => {
    it('queues one request for the selected emails in list order, then opens the chat with each attached and a message staged', async () => {
      await renderManager();
      await click(checkbox('Order 3'));
      await click(checkbox('Order 1'));
      await click(draftButton(2));

      expect(api.draftWithAi).toHaveBeenCalledTimes(1);
      // list order, not click order
      expect(api.draftWithAi).toHaveBeenCalledWith(['r-1', 'r-3'], 'receipt');
      expect(api.get).toHaveBeenCalledTimes(2);
      expect(toast.success).toHaveBeenCalledWith('Opened the chat with the emails attached. Read the message and press Send.');

      const push = useRouter().push as ReturnType<typeof vi.fn>;
      const url = push.mock.calls.at(-1)?.[0] as string;
      expect(url).toMatch(/^\/ai\?handoff=[0-9a-f-]{36}$/);
      const handoff = peekChatHandoff(url.replace('/ai?handoff=', ''));
      expect(handoff?.files).toHaveLength(2);
      expect(handoff?.files.map((file) => file.name)).toEqual(['order-email-1-2026-08-10.txt', 'order-email-2-2026-08-10.txt']);
      const first = await handoff!.files[0].text();
      expect(first).toContain('Id: r-1');
      expect(first).toContain('Forwarded by: alice.example@gmail.example.com');
      expect(first).toContain('Widget r-1 12.00');
      // The message names the count, the sender and the request to claim, and is only STAGED.
      expect(handoff?.draft).toBe(
        'Build an email receipt profile for these 2 order emails from shop.example.com. Claim AI review request req-draft, test your profile on every attached email with the email_receipt_parsers tool, fix it until each one reads completely, then save it as a draft for request req-draft.',
      );
    });

    it('says "this order email" for one email', async () => {
      await renderManager();
      await click(checkbox('Order 2'));
      await click(draftButton(1));

      const push = useRouter().push as ReturnType<typeof vi.fn>;
      const handoff = peekChatHandoff((push.mock.calls.at(-1)?.[0] as string).replace('/ai?handoff=', ''));
      expect(handoff?.draft).toContain('Build an email receipt profile for this order email from shop.example.com.');
    });

    it('never sends the message: nothing but the router is touched, and the selection is cleared', async () => {
      await renderManager();
      await click(checkbox('Order 1'));
      await click(draftButton(1));
      expect(bar()).not.toBeInTheDocument();
    });

    it('queues the request, opens no chat and says so when no assistant can answer now (no provider)', async () => {
      assistant.canAnswer.mockResolvedValue(false);
      await renderManager();
      await click(checkbox('Order 1'));
      await click(draftButton(1));

      expect(api.draftWithAi).toHaveBeenCalledWith(['r-1'], 'receipt');
      expect(api.get).not.toHaveBeenCalled();
      expect(useRouter().push).not.toHaveBeenCalled();
      const notice = screen.getByRole('status');
      expect(notice).toHaveTextContent('Queued: the request waits in the AI review inbox for an agent');
      expect(within(notice).getByRole('link', { name: 'Open the AI review inbox' })).toHaveAttribute('href', '/ai-reviews');
    });

    it('decides whether the assistant can answer after the request is queued: a relay agent that is not connected leaves it waiting', async () => {
      assistant.canAnswer.mockResolvedValue(false);
      await renderManager();
      await click(checkbox('Order 1'));
      await click(draftButton(1));

      expect(api.draftWithAi.mock.invocationCallOrder[0]).toBeLessThan(assistant.canAnswer.mock.invocationCallOrder[0]);
    });

    it('says the request is queued when the emails could not be read for the chat, and opens no chat', async () => {
      api.get.mockRejectedValueOnce(new Error('down'));
      await renderManager();
      await click(checkbox('Order 1'));
      await click(draftButton(1));

      expect(screen.getByRole('status')).toHaveTextContent('the emails could not be opened in the chat');
      expect(useRouter().push).not.toHaveBeenCalled();
    });

    it("shows the server's refusal and queues nothing, keeping the selection", async () => {
      api.draftWithAi.mockRejectedValue({ response: { data: { message: 'This email could not be read' } } });
      await renderManager();
      await click(checkbox('Order 1'));
      await click(draftButton(1));

      expect(screen.getByRole('alert')).toHaveTextContent('This email could not be read');
      expect(assistant.canAnswer).not.toHaveBeenCalled();
      expect(api.get).not.toHaveBeenCalled();
      expect(useRouter().push).not.toHaveBeenCalled();
      expect(bar()).toBeInTheDocument();
    });

    it('names a failure that carries no message', async () => {
      api.draftWithAi.mockRejectedValue(new Error('network'));
      await renderManager();
      await click(checkbox('Order 1'));
      await click(draftButton(1));
      expect(screen.getByRole('alert')).toHaveTextContent(/Could not start drafting a profile|network/);
    });

    it('waits while the request is in flight: no second press, no change of selection', async () => {
      let resolve!: (value: unknown) => void;
      api.draftWithAi.mockReturnValueOnce(new Promise((r) => (resolve = r)));
      await renderManager();
      await click(checkbox('Order 1'));
      await act(async () => {
        fireEvent.click(draftButton(1));
      });
      expect(draftButton(1)).toBeDisabled();
      expect(screen.getByRole('button', { name: 'Delete (1)' })).toBeDisabled();
      await act(async () => {
        resolve({ ok: true, requestId: 'req-1' });
      });
    });
  });

  describe('trade confirmations', () => {
    const fills = [
      shop(1, { isTrade: true, tradeSource: 'profile', status: 'parse_failed', statusReason: 'trade_no_account' }),
      shop(2, { isTrade: true, tradeSource: 'profile', status: 'parse_failed', statusReason: 'trade_no_symbol' }),
      shop(3),
    ];

    it('asks for a trade profile when every selected email is a trade confirmation, with a trade message staged', async () => {
      api.list.mockResolvedValue(fills);
      await renderManager();
      await click(checkbox('Order 1'));
      await click(checkbox('Order 2'));
      await click(draftButton(2));

      expect(api.draftWithAi).toHaveBeenCalledWith(['r-1', 'r-2'], 'trade');
      const push = useRouter().push as ReturnType<typeof vi.fn>;
      const handoff = peekChatHandoff((push.mock.calls.at(-1)?.[0] as string).replace('/ai?handoff=', ''));
      expect(handoff?.draft).toContain('Build a trade profile for these 2 trade confirmation emails from shop.example.com.');
    });

    it('asks for a trade profile from a trade email\'s own row action', async () => {
      api.list.mockResolvedValue(fills);
      await renderManager();
      // A parse_failed email leads with Reprocess: the draft action is in the row's menu.
      const row = screen.getByRole('row', { name: /Order 2/ });
      const inline = within(row).queryByRole('button', { name: 'Prepare a profile with AI' });
      if (inline) await click(inline);
      else {
        await click(within(row).getByRole('button', { name: 'More actions' }));
        await click(screen.getByRole('menuitem', { name: 'Prepare a profile with AI' }));
      }
      expect(api.draftWithAi).toHaveBeenCalledWith(['r-2'], 'trade');
    });

    it('refuses a mix of trade confirmations and order emails, and says why', async () => {
      api.list.mockResolvedValue(fills);
      await renderManager();
      await click(checkbox('Order 1'));
      await click(checkbox('Order 3'));

      expect(draftButton(2)).toBeDisabled();
      const why = within(bar()!).getByText(/The selected emails mix trade confirmations and order emails/);
      expect(draftButton(2)).toHaveAttribute('aria-describedby', why.id);
      expect(api.draftWithAi).not.toHaveBeenCalled();
    });
  });

  describe('the row action', () => {
    it('drafts from that one email through the same flow', async () => {
      await renderManager();
      const row = screen.getByRole('row', { name: /Order 4/ });
      await click(within(row).getByRole('button', { name: 'Prepare a profile with AI' }));

      expect(api.draftWithAi).toHaveBeenCalledWith(['r-4'], 'receipt');
      expect(api.get).toHaveBeenCalledWith('r-4');
      const push = useRouter().push as ReturnType<typeof vi.fn>;
      expect(push.mock.calls.at(-1)?.[0]).toMatch(/^\/ai\?handoff=/);
    });

    it('says it waits in the inbox when no assistant can answer now', async () => {
      assistant.canAnswer.mockResolvedValue(false);
      await renderManager();
      const row = screen.getByRole('row', { name: /Order 4/ });
      await click(within(row).getByRole('button', { name: 'Prepare a profile with AI' }));

      expect(screen.getByRole('status')).toHaveTextContent('Queued');
      expect(api.get).not.toHaveBeenCalled();
    });
  });

  describe('a draft over several senders', () => {
    beforeEach(() => {
      api.list.mockResolvedValue([shop(1), shop(2), shop(3, other)]);
    });

    it('asks first, naming the senders with their email counts and the limits, and sends nothing yet', async () => {
      await renderManager();
      for (const n of [1, 2, 3]) await click(checkbox(`Order ${n}`));
      await click(draftButton(3));

      const dialog = screen.getByRole('dialog');
      expect(within(dialog).getByText('Draft linked profiles?')).toBeInTheDocument();
      expect(dialog).toHaveTextContent('shop.example.com (2 emails), other.example.org (1 email)');
      expect(dialog).toHaveTextContent('one bank transaction');
      expect(dialog).toHaveTextContent('one domain at a time');
      expect(dialog).toHaveTextContent('at most 5 emails per sender and at most 5 senders');
      expect(within(dialog).getByRole('button', { name: 'Draft linked profiles' })).toBeInTheDocument();
      expect(api.draftWithAi).not.toHaveBeenCalled();
    });

    it('sends nothing on Cancel and keeps the selection', async () => {
      await renderManager();
      for (const n of [1, 2, 3]) await click(checkbox(`Order ${n}`));
      await click(draftButton(3));
      await click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Cancel' }));

      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      expect(api.draftWithAi).not.toHaveBeenCalled();
      expect(bar()).toHaveTextContent('3 emails selected');
    });

    it('sends the selected ids on confirm', async () => {
      await renderManager();
      for (const n of [1, 2, 3]) await click(checkbox(`Order ${n}`));
      await click(draftButton(3));
      await click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Draft linked profiles' }));

      expect(api.draftWithAi).toHaveBeenCalledTimes(1);
      expect(api.draftWithAi).toHaveBeenCalledWith(['r-1', 'r-2', 'r-3'], 'receipt');
    });

    it('goes through the same dialog when every email of the page is selected with the header checkbox', async () => {
      await renderManager();
      await click(screen.getByRole('checkbox', { name: 'Select all emails on this list' }));
      await click(draftButton(3));

      expect(screen.getByRole('dialog')).toBeInTheDocument();
      expect(api.draftWithAi).not.toHaveBeenCalled();
    });

    it('asks nothing for one sender', async () => {
      await renderManager();
      await click(checkbox('Order 1'));
      await click(checkbox('Order 2'));
      await click(draftButton(2));

      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      expect(api.draftWithAi).toHaveBeenCalledWith(['r-1', 'r-2'], 'receipt');
    });
  });

  describe('the permanent hint', () => {
    it('is shown on the list before anything is selected', async () => {
      await renderManager();
      expect(bar()).not.toBeInTheDocument();
      expect(
        screen.getByText(/One bank transaction described by emails from several senders .* draft linked profiles\./),
      ).toBeInTheDocument();
    });
  });
});
