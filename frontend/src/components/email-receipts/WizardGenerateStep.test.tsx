import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AxiosError } from 'axios';
import { render, screen, fireEvent, act } from '@/test/render';
import { WizardGenerateStep } from './WizardGenerateStep';

const api = vi.hoisted(() => ({ generateWithAi: vi.fn() }));
vi.mock('@/lib/email-receipts-api', () => ({ emailReceiptsApi: { parsers: api } }));
vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() }),
}));

const samples = [
  { receiptId: 'r-1', chosen: { transactionId: 'tx-1', summary: 'Sep 1, 25.00, Allegro', subject: 'Order 1' }, subject: 'Order 1' },
  { receiptId: 'r-2', chosen: { transactionId: 'tx-2', summary: 'Sep 2, 30.00, Allegro', subject: 'Order 2' }, subject: 'Order 2' },
];

function refusal(data: unknown) {
  return new AxiosError('unprocessable', '422', undefined, undefined, { status: 422, data } as never);
}

async function click(element: HTMLElement) {
  await act(async () => {
    fireEvent.click(element);
  });
  await act(async () => {});
}

async function renderStep(
  draft: { parserId: string; revision: number | null } | null = null,
  extra: Partial<React.ComponentProps<typeof WizardGenerateStep>> = {},
) {
  const props = { onGenerated: vi.fn(), onQueued: vi.fn(), onBack: vi.fn() };
  await act(async () => {
    render(<WizardGenerateStep domain="allegro.pl" samples={samples} kind="receipt" draft={draft} {...props} {...extra} />);
  });
  return props;
}

describe('WizardGenerateStep', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('lists the pairs and sends them to the assistant', async () => {
    api.generateWithAi.mockResolvedValue({ parserId: 'p-1', revision: 3, answer: 'Done' });
    const props = await renderStep();
    expect(screen.getByText('Order 1')).toBeInTheDocument();
    expect(screen.getByText('Sep 2, 30.00, Allegro')).toBeInTheDocument();
    await click(screen.getByRole('button', { name: 'Send to AI' }));
    expect(api.generateWithAi).toHaveBeenCalledWith({
      domain: 'allegro.pl',
      samples: [
        { receiptId: 'r-1', transactionId: 'tx-1' },
        { receiptId: 'r-2', transactionId: 'tx-2' },
      ],
    });
    expect(props.onGenerated).toHaveBeenCalledWith({ parserId: 'p-1', revision: 3 }, 'Done');
  });

  it('shows a progress state while the assistant works', async () => {
    let release!: (value: unknown) => void;
    api.generateWithAi.mockImplementationOnce(() => new Promise((resolve) => (release = resolve)));
    await renderStep();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Send to AI' }));
    });
    expect(screen.getByRole('status')).toHaveTextContent('The assistant is writing the profile...');
    expect(screen.getByRole('status')).toHaveTextContent('This can take a minute');
    expect(screen.getByRole('button', { name: 'Back' })).toBeDisabled();
    await act(async () => {
      release({ parserId: 'p-1', revision: 1, answer: '' });
    });
  });

  it('shows the assistant\'s answer on a 422 and lets the person send again', async () => {
    api.generateWithAi.mockRejectedValueOnce(refusal({ message: 'No draft', answer: 'The totals differ between the emails.' }));
    const props = await renderStep();
    await click(screen.getByRole('button', { name: 'Send to AI' }));
    expect(screen.getByRole('alert')).toHaveTextContent('The assistant did not save a draft.');
    expect(screen.getByRole('alert')).toHaveTextContent('The totals differ between the emails.');
    api.generateWithAi.mockResolvedValueOnce({ parserId: 'p-2', revision: 1, answer: 'ok' });
    await click(screen.getByRole('button', { name: 'Send to AI again' }));
    expect(api.generateWithAi).toHaveBeenCalledTimes(2);
    expect(props.onGenerated).toHaveBeenCalledWith({ parserId: 'p-2', revision: 1 }, 'ok');
  });

  it('names the server\'s reason for any other failure', async () => {
    api.generateWithAi.mockRejectedValueOnce(
      new AxiosError('bad', '500', undefined, undefined, { status: 500, data: { message: 'AI provider is not configured' } } as never),
    );
    await renderStep();
    await click(screen.getByRole('button', { name: 'Send to AI' }));
    expect(screen.getByRole('alert')).toHaveTextContent('AI provider is not configured');
  });

  it('revises the draft with a note: the note is required and goes with the draft id', async () => {
    api.generateWithAi.mockResolvedValue({ parserId: 'p-1', revision: 4, answer: 'Fixed' });
    const props = await renderStep({ parserId: 'p-1', revision: 3 });
    expect(screen.getByRole('button', { name: 'Send note to AI' })).toBeDisabled();
    await act(async () => {
      fireEvent.change(screen.getByLabelText('Requested Changes'), { target: { value: '  Use the Amount paid line.  ' } });
    });
    await click(screen.getByRole('button', { name: 'Send note to AI' }));
    expect(api.generateWithAi).toHaveBeenCalledWith(
      expect.objectContaining({ parserId: 'p-1', feedback: 'Use the Amount paid line.' }),
    );
    expect(props.onGenerated).toHaveBeenCalledWith({ parserId: 'p-1', revision: 4 }, 'Fixed');
  });

  it('hands a queued request (the user\'s own agent answers) to the wizard instead of generating', async () => {
    api.generateWithAi.mockResolvedValue({ status: 'queued', requestId: 'req-1' });
    const props = await renderStep();
    await click(screen.getByRole('button', { name: 'Send to AI' }));
    expect(props.onQueued).toHaveBeenCalledWith('req-1');
    expect(props.onGenerated).not.toHaveBeenCalled();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('queues a revision with its note too', async () => {
    api.generateWithAi.mockResolvedValue({ status: 'queued', requestId: 'req-2' });
    const props = await renderStep({ parserId: 'p-1', revision: 3 });
    await act(async () => {
      fireEvent.change(screen.getByLabelText('Requested Changes'), { target: { value: 'Use the paid line' } });
    });
    await click(screen.getByRole('button', { name: 'Send note to AI' }));
    expect(api.generateWithAi).toHaveBeenCalledWith(expect.objectContaining({ parserId: 'p-1', feedback: 'Use the paid line' }));
    expect(props.onQueued).toHaveBeenCalledWith('req-2');
  });

  it('says the request could not be sent (not that the assistant saved no draft) when the agent is already working on one', async () => {
    api.generateWithAi.mockRejectedValueOnce(
      new AxiosError('conflict', '409', undefined, undefined, {
        status: 409,
        data: { message: 'Your AI agent is already working on a profile for this sender.' },
      } as never),
    );
    await renderStep();
    await click(screen.getByRole('button', { name: 'Send to AI' }));
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent('The request could not be sent.');
    expect(alert).toHaveTextContent('Your AI agent is already working on a profile for this sender.');
    expect(alert).not.toHaveTextContent('did not save a draft');
  });

  it('goes back', async () => {
    const props = await renderStep();
    await click(screen.getByRole('button', { name: 'Back' }));
    expect(props.onBack).toHaveBeenCalledTimes(1);
  });

  describe('trade confirmations', () => {
    const tradeSamples = [
      { receiptId: 'r-1', chosen: null, subject: 'Your order has been filled' },
      { receiptId: 'r-2', chosen: null, subject: 'Your order has been filled (2)' },
    ];

    it('sends the emails only, as a trade request, and says nothing is paired', async () => {
      api.generateWithAi.mockResolvedValue({ parserId: 'p-1', revision: 1, answer: 'Done' });
      const props = await renderStep(null, { kind: 'trade', samples: tradeSamples });
      expect(screen.getByText('Your order has been filled')).toBeInTheDocument();
      expect(screen.getAllByText('Trade confirmation')).toHaveLength(2);
      expect(screen.getByText(/proposes the investment transaction each one reports/)).toBeInTheDocument();
      await click(screen.getByRole('button', { name: 'Send to AI' }));
      expect(api.generateWithAi).toHaveBeenCalledWith({
        domain: 'allegro.pl',
        kind: 'trade',
        tradeReceiptIds: ['r-1', 'r-2'],
      });
      expect(props.onGenerated).toHaveBeenCalledWith({ parserId: 'p-1', revision: 1 }, 'Done');
    });

    it('revises the same draft with a note', async () => {
      api.generateWithAi.mockResolvedValue({ parserId: 'p-1', revision: 2, answer: 'ok' });
      await renderStep({ parserId: 'p-1', revision: 1 }, { kind: 'trade', samples: tradeSamples });
      await act(async () => {
        fireEvent.change(screen.getByLabelText('Requested Changes'), { target: { value: 'Read the commission' } });
      });
      await click(screen.getByRole('button', { name: 'Send note to AI' }));
      expect(api.generateWithAi).toHaveBeenCalledWith({
        domain: 'allegro.pl',
        kind: 'trade',
        tradeReceiptIds: ['r-1', 'r-2'],
        parserId: 'p-1',
        feedback: 'Read the commission',
      });
    });
  });
});
