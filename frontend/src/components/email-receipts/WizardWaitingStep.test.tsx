import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act } from '@/test/render';
import { WizardWaitingStep, WIZARD_WAIT_POLL_MS } from './WizardWaitingStep';

const api = vi.hoisted(() => ({ listUncovered: vi.fn(), get: vi.fn() }));
vi.mock('@/lib/email-receipts-api', () => ({
  emailReceiptsApi: { receipts: { listUncovered: api.listUncovered }, parsers: { get: api.get } },
}));
vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() }),
}));

const waitingEntry = (status: 'pending' | 'claimed' = 'pending', draftParserId: string | null = null) => ({
  domain: 'allegro.pl',
  count: 2,
  draftParserId,
  pendingRequestId: 'req-1',
  pendingRequestStatus: status,
});
const answeredEntry = (draftParserId: string | null) => ({
  domain: 'allegro.pl',
  count: 2,
  draftParserId,
  pendingRequestId: null,
  pendingRequestStatus: null,
});

async function renderStep(baseline: { parserId: string | null; revision: number | null } = { parserId: null, revision: null }) {
  const props = { onArrived: vi.fn(), onStartOver: vi.fn() };
  let unmount!: () => void;
  await act(async () => {
    unmount = render(<WizardWaitingStep domain="allegro.pl" baseline={baseline} {...props} />).unmount;
  });
  return Object.assign(props, { unmount });
}

async function tick(ms = WIZARD_WAIT_POLL_MS) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

describe('WizardWaitingStep', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    api.listUncovered.mockResolvedValue([waitingEntry()]);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('says the request is in the AI inbox, links to it and offers to check now and start over', async () => {
    await renderStep();
    expect(screen.getByRole('status')).toHaveTextContent(
      'Sent to the AI inbox. Your agent will prepare the profile when it connects; you can close this and come back.',
    );
    expect(screen.getByRole('link', { name: 'Open the AI inbox' })).toHaveAttribute('href', '/ai-reviews');
    expect(screen.getByRole('button', { name: 'Check now' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Start over' })).toBeInTheDocument();
    expect(api.listUncovered).not.toHaveBeenCalled();
  });

  it('polls every 15 seconds and keeps waiting while the request is open, noting when the agent works on it', async () => {
    const props = await renderStep();
    await tick();
    expect(api.listUncovered).toHaveBeenCalledTimes(1);
    expect(screen.queryByText(/picked up the request/)).not.toBeInTheDocument();
    api.listUncovered.mockResolvedValue([waitingEntry('claimed')]);
    await tick();
    expect(api.listUncovered).toHaveBeenCalledTimes(2);
    expect(screen.getByRole('status')).toHaveTextContent('Your agent has picked up the request and is working on it.');
    expect(props.onArrived).not.toHaveBeenCalled();
  });

  it('moves on when the request is answered with a new draft', async () => {
    const props = await renderStep();
    api.listUncovered.mockResolvedValue([answeredEntry('p-new')]);
    api.get.mockResolvedValue({ id: 'p-new', revision: 1 });
    await tick();
    expect(api.get).toHaveBeenCalledWith('p-new');
    expect(props.onArrived).toHaveBeenCalledWith({ parserId: 'p-new', revision: 1 });
  });

  it('moves on when the same draft has a newer revision than the one the wait began with', async () => {
    const props = await renderStep({ parserId: 'p-1', revision: 2 });
    api.listUncovered.mockResolvedValue([answeredEntry('p-1')]);
    api.get.mockResolvedValue({ id: 'p-1', revision: 3 });
    await tick();
    expect(props.onArrived).toHaveBeenCalledWith({ parserId: 'p-1', revision: 3 });
  });

  it('reads the revision of a baseline draft whose revision is unknown, once, before any answer', async () => {
    const props = await renderStep({ parserId: 'p-1', revision: null });
    expect(api.get).toHaveBeenCalledWith('p-1');
    api.get.mockResolvedValue({ id: 'p-1', revision: 2 });
    api.listUncovered.mockResolvedValue([answeredEntry('p-1')]);
    await tick();
    // the draft is still revision 2 (what the wait began with): no answer
    expect(props.onArrived).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toHaveTextContent('closed without a new draft');
  });

  it('says so when the request is gone and there is no new draft, and starts over on request', async () => {
    const props = await renderStep();
    api.listUncovered.mockResolvedValue([answeredEntry(null)]);
    await tick();
    expect(screen.getByRole('alert')).toHaveTextContent('The request was closed without a new draft');
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Start over' }));
    });
    expect(props.onStartOver).toHaveBeenCalledTimes(1);
    expect(props.onArrived).not.toHaveBeenCalled();
  });

  it('checks on demand', async () => {
    const props = await renderStep();
    api.listUncovered.mockResolvedValue([answeredEntry('p-9')]);
    api.get.mockResolvedValue({ id: 'p-9', revision: 4 });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Check now' }));
    });
    expect(api.listUncovered).toHaveBeenCalledTimes(1);
    expect(props.onArrived).toHaveBeenCalledWith({ parserId: 'p-9', revision: 4 });
  });

  it('reports a failed check and keeps polling', async () => {
    const props = await renderStep();
    api.listUncovered.mockRejectedValueOnce(new Error('down'));
    await tick();
    expect(screen.getByRole('alert')).toHaveTextContent('The request could not be checked');
    api.listUncovered.mockResolvedValue([answeredEntry('p-2')]);
    api.get.mockResolvedValue({ id: 'p-2', revision: 1 });
    await tick();
    expect(props.onArrived).toHaveBeenCalledWith({ parserId: 'p-2', revision: 1 });
  });

  it('stops polling when it unmounts', async () => {
    const { unmount } = await renderStep();
    await tick();
    expect(api.listUncovered).toHaveBeenCalledTimes(1);
    unmount();
    await tick(WIZARD_WAIT_POLL_MS * 3);
    expect(api.listUncovered).toHaveBeenCalledTimes(1);
  });
});
