import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, act } from '@/test/render';
import { EmailReceiptsHub, tabFromSearch } from './EmailReceiptsHub';
import { TOUR_ANCHORS, tourAnchorSelector } from '@/lib/tours/anchors';

const nav = vi.hoisted(() => ({ search: '', replace: vi.fn() }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: nav.replace, back: vi.fn(), prefetch: vi.fn(), refresh: vi.fn() }),
  usePathname: () => '/email-receipts',
  useSearchParams: () => new URLSearchParams(nav.search),
}));
vi.mock('@/components/email-receipts/EmailReceiptsOverview', () => ({
  EmailReceiptsOverview: () => <div data-testid="overview" />,
}));
vi.mock('@/components/email-receipts/EmailReceiptsManager', () => ({
  EmailReceiptsManager: () => <div data-testid="emails" />,
}));
vi.mock('@/components/email-receipts/ParsersSection', () => ({
  ParsersSection: ({
    wizardDomain,
    onWizardDomainChange,
    onOpenEmails,
  }: {
    wizardDomain?: string | null;
    onWizardDomainChange?: (d: string | null) => void;
    onOpenEmails?: () => void;
  }) => (
    <div data-testid="profiles" data-wizard={wizardDomain ?? ''}>
      <button type="button" onClick={() => onWizardDomainChange?.('shop.example.com')}>
        start wizard
      </button>
      <button type="button" onClick={() => onWizardDomainChange?.(null)}>
        close wizard
      </button>
      <button type="button" onClick={() => onOpenEmails?.()}>
        open emails hint
      </button>
    </div>
  ),
}));
vi.mock('@/components/email-receipts/MailboxSection', () => ({
  MailboxSection: () => <div data-testid="mailbox" />,
}));
let demoMode = false;
vi.mock('@/hooks/useDemoMode', () => ({ useDemoMode: () => demoMode }));

async function renderHub(search = '') {
  nav.search = search;
  await act(async () => {
    render(<EmailReceiptsHub />);
  });
}

describe('tabFromSearch', () => {
  it.each([
    ['overview', false, 'overview'],
    ['emails', false, 'emails'],
    ['profiles', false, 'profiles'],
    ['mailbox', true, 'mailbox'],
    [null, false, 'overview'],
    [null, true, 'emails'],
    ['nonsense', false, 'overview'],
    ['nonsense', true, 'emails'],
  ] as const)('reads tab=%s with a domain %s as %s', (tab, hasDomain, expected) => {
    expect(tabFromSearch(tab, hasDomain)).toBe(expected);
  });
});

describe('EmailReceiptsHub', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    demoMode = false;
  });

  it('switches to the Emails tab from the Profiles tab hint', async () => {
    await renderHub('tab=profiles');
    fireEvent.click(screen.getByRole('button', { name: 'open emails hint' }));
    expect(nav.replace).toHaveBeenCalledWith('/email-receipts?tab=emails', { scroll: false });
  });

  it('opens on the Overview and mounts only that tab', async () => {
    await renderHub();
    expect(screen.getByRole('tab', { name: 'Overview' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByTestId('overview')).toBeInTheDocument();
    expect(screen.queryByTestId('emails')).not.toBeInTheDocument();
    expect(screen.queryByTestId('mailbox')).not.toBeInTheDocument();
  });

  it.each([
    ['tab=emails', 'emails'],
    ['tab=profiles', 'profiles'],
    ['tab=mailbox', 'mailbox'],
    ['domain=shop.example.com', 'emails'],
  ])('opens the tab a link names (%s)', async (search, testId) => {
    await renderHub(search);
    expect(screen.getByTestId(testId)).toBeInTheDocument();
  });

  it('marks the tab bar as the email receipts tour anchor', async () => {
    await renderHub('tab=profiles');
    const anchor = document.querySelector(tourAnchorSelector(TOUR_ANCHORS.emailReceiptsTabs));
    expect(anchor).toContainElement(screen.getByRole('tab', { name: 'Profiles' }));
  });

  it('orders the tabs overview, mailbox, profiles, emails', async () => {
    await renderHub();
    expect(screen.getAllByRole('tab').map((tab) => tab.textContent)).toEqual(['Overview', 'Mailbox', 'Profiles', 'Emails']);
  });

  it('keeps the wizard domain in the URL and reads it back', async () => {
    await renderHub('tab=profiles');
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'start wizard' }));
    });
    expect(nav.replace).toHaveBeenCalledWith('/email-receipts?tab=profiles&wizard=shop.example.com', { scroll: false });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'close wizard' }));
    });
    expect(nav.replace).toHaveBeenLastCalledWith('/email-receipts?tab=profiles', { scroll: false });
  });

  it('hands the wizard domain of the URL to the Profiles tab', async () => {
    await renderHub('tab=profiles&wizard=Shop.Example.com');
    expect(screen.getByTestId('profiles')).toHaveAttribute('data-wizard', 'shop.example.com');
  });

  it('writes the chosen tab to the URL', async () => {
    await renderHub();
    await act(async () => {
      fireEvent.click(screen.getByRole('tab', { name: 'Profiles' }));
    });
    expect(nav.replace).toHaveBeenCalledWith('/email-receipts?tab=profiles', { scroll: false });
  });

  it('drops the sender filter when another tab is chosen', async () => {
    await renderHub('tab=emails&domain=shop.example.com');
    await act(async () => {
      fireEvent.click(screen.getByRole('tab', { name: 'Mailbox' }));
    });
    expect(nav.replace).toHaveBeenCalledWith('/email-receipts?tab=mailbox', { scroll: false });
  });

  it('does not rewrite the URL for the tab already open', async () => {
    await renderHub('tab=emails');
    await act(async () => {
      fireEvent.click(screen.getByRole('tab', { name: 'Emails' }));
    });
    expect(nav.replace).not.toHaveBeenCalled();
  });

  it('gives the demo account the explanation on Profiles and Mailbox and none of their controls', async () => {
    demoMode = true;
    await renderHub('tab=mailbox');
    expect(screen.getByText('Restricted in Demo Mode')).toBeInTheDocument();
    expect(screen.queryByTestId('mailbox')).not.toBeInTheDocument();
  });

  it('keeps the Overview and the Emails for the demo account', async () => {
    demoMode = true;
    await renderHub('tab=emails');
    expect(screen.getByTestId('emails')).toBeInTheDocument();
  });
});
