import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, act, within } from '@/test/render';
import { EmailReceiptsOverview } from './EmailReceiptsOverview';
import { makeOverview } from './email-receipts-fixtures';

const api = vi.hoisted(() => ({ overview: vi.fn() }));
vi.mock('@/lib/email-receipts-api', () => ({ emailReceiptsApi: { receipts: api } }));
vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() }),
}));

async function renderOverview() {
  await act(async () => {
    render(<EmailReceiptsOverview />);
  });
  await act(async () => {});
}

async function click(element: HTMLElement) {
  await act(async () => {
    fireEvent.click(element);
  });
  await act(async () => {});
}

const established = (over: Parameters<typeof makeOverview>[0] = {}) =>
  makeOverview({
    emailsByStatus: { review: 4, unmatched: 2, no_parser: 3 },
    processable: 5,
    proposalsToApprove: 4,
    parsers: { approved: 2, draft: 1 },
    ...over,
  });

describe('EmailReceiptsOverview', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shows a spinner, then the cards from the one request', async () => {
    api.overview.mockResolvedValue(established());
    await renderOverview();
    expect(api.overview).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('heading', { name: 'Mailbox' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Emails' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Proposals' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Profiles' })).toBeInTheDocument();
  });

  it('counts the stored emails of every status and links the review inbox for the proposals', async () => {
    api.overview.mockResolvedValue(established());
    await renderOverview();
    const emails = screen.getByRole('heading', { name: 'Emails' }).parentElement!;
    expect(within(emails).getByText('9')).toBeInTheDocument();
    expect(within(emails).getByText('5 emails can be processed again.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Review the proposals' })).toHaveAttribute('href', '/ai-reviews?kind=email_receipt');
  });

  it('says polling is on, with the last success', async () => {
    api.overview.mockResolvedValue(established());
    await renderOverview();
    expect(screen.getByText('Polling')).toBeInTheDocument();
    expect(screen.getByText(/Last successful poll/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open the mailbox settings' })).toHaveAttribute('href', '/email-receipts?tab=mailbox');
  });

  it('says the last poll failed, with the error, when the error is newer than the last success', async () => {
    const base = established();
    api.overview.mockResolvedValue({
      ...base,
      mailbox: { ...base.mailbox!, lastError: 'Login refused', lastErrorAt: '2026-10-04T10:00:00.000Z' },
    });
    await renderOverview();
    expect(screen.getByText('Last poll failed')).toBeInTheDocument();
    expect(screen.getByText('Last error: Login refused')).toBeInTheDocument();
  });

  it('keeps saying polling when an old error is older than the last success', async () => {
    const base = established();
    api.overview.mockResolvedValue({
      ...base,
      mailbox: { ...base.mailbox!, lastError: 'Old', lastErrorAt: '2026-10-01T10:00:00.000Z' },
    });
    await renderOverview();
    expect(screen.getByText('Polling')).toBeInTheDocument();
  });

  it.each([
    ['not connected', { connected: false }, 'Not connected'],
    ['switched off', { enabled: false }, 'Polling is off'],
  ])('says so when the mailbox is %s', async (_name, patch, text) => {
    const base = established();
    api.overview.mockResolvedValue({ ...base, mailbox: { ...base.mailbox!, ...patch } });
    await renderOverview();
    expect(screen.getByText(text)).toBeInTheDocument();
  });

  it('invites to connect a mailbox when there is none', async () => {
    api.overview.mockResolvedValue(makeOverview({ mailbox: null }));
    await renderOverview();
    expect(screen.getByText('No mailbox is connected yet.')).toBeInTheDocument();
    // The wizard and the card both point at the mailbox.
    expect(screen.getAllByRole('link', { name: 'Connect a mailbox' }).length).toBeGreaterThan(0);
  });

  it('draws the first-run wizard until a profile is approved, and not after', async () => {
    api.overview.mockResolvedValue(makeOverview({ emailsByStatus: { no_parser: 2 } }));
    await renderOverview();
    expect(screen.getByRole('heading', { name: 'Get started with email receipts' })).toBeInTheDocument();
  });

  it('has no wizard for an established account', async () => {
    api.overview.mockResolvedValue(established());
    await renderOverview();
    expect(screen.queryByRole('heading', { name: 'Get started with email receipts' })).not.toBeInTheDocument();
  });

  it('lists the senders no profile covers, each linking to the profile wizard', async () => {
    api.overview.mockResolvedValue(
      established({ domainsWithoutProfile: [{ domain: 'shop.example.com', count: 3 }, { domain: 'x.example', count: 1 }] }),
    );
    await renderOverview();
    expect(screen.getByText('shop.example.com (3 emails)')).toBeInTheDocument();
    expect(screen.getByText('x.example (1 email)')).toBeInTheDocument();
    expect(screen.getAllByRole('link', { name: 'Create a profile' })[0]).toHaveAttribute(
      'href',
      '/email-receipts?tab=profiles&wizard=shop.example.com',
    );
  });

  it('says every sender is covered when none is listed', async () => {
    api.overview.mockResolvedValue(established());
    await renderOverview();
    expect(screen.getByText('Every sender of the stored emails is covered by a profile.')).toBeInTheDocument();
  });

  it('mentions the drafts waiting for approval', async () => {
    api.overview.mockResolvedValue(established());
    await renderOverview();
    expect(screen.getByText('1 draft waits for your approval.')).toBeInTheDocument();
  });

  it('has no manual processing button: parsing is automatic', async () => {
    api.overview.mockResolvedValue(established());
    await renderOverview();
    expect(screen.queryByRole('button', { name: /Process all/ })).not.toBeInTheDocument();
  });

  it('shows a failed load as an error with a retry, never as an empty account', async () => {
    api.overview.mockRejectedValueOnce(new Error('down'));
    await renderOverview();
    expect(screen.getByRole('alert')).toHaveTextContent('The overview could not be loaded');
    expect(screen.queryByRole('heading', { name: 'Get started with email receipts' })).not.toBeInTheDocument();
    api.overview.mockResolvedValue(established());
    await click(screen.getByRole('button', { name: 'Try again' }));
    expect(screen.getByRole('heading', { name: 'Mailbox' })).toBeInTheDocument();
  });
});
