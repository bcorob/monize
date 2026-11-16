import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup } from '@/test/render';
import { usePreferencesStore } from '@/store/preferencesStore';
import { WarrantyStatusBadge } from './WarrantyStatusBadge';

describe('WarrantyStatusBadge', () => {
  beforeEach(() => {
    usePreferencesStore.setState({ preferences: null });
  });

  afterEach(() => {
    cleanup();
    usePreferencesStore.setState({ preferences: null });
  });

  it.each([
    ['lifetime', 'Lifetime', 'bg-blue-100'],
    ['active', 'Active', 'bg-green-100'],
    ['expiring', 'Expiring soon', 'bg-amber-100'],
    ['expired', 'Expired', 'bg-red-100'],
  ] as const)('labels the server status %s', (status, label, colour) => {
    render(<WarrantyStatusBadge warranty={{ status, daysLeft: status === 'lifetime' ? null : 10 }} />);
    const pill = screen.getByText(label);
    expect(pill.className).toContain(colour);
  });

  it('prints no days-left line unless asked', () => {
    render(<WarrantyStatusBadge warranty={{ status: 'active', daysLeft: 45 }} />);
    expect(screen.queryByText(/days left/)).not.toBeInTheDocument();
  });

  it('prints the days left from daysLeft', () => {
    render(<WarrantyStatusBadge warranty={{ status: 'active', daysLeft: 45 }} showDaysLeft />);
    expect(screen.getByText('45 days left')).toBeInTheDocument();
  });

  it('uses the singular for one day', () => {
    render(<WarrantyStatusBadge warranty={{ status: 'expiring', daysLeft: 1 }} showDaysLeft />);
    expect(screen.getByText('1 day left')).toBeInTheDocument();
  });

  it('prints years and days from a year up', () => {
    render(<WarrantyStatusBadge warranty={{ status: 'active', daysLeft: 3 * 365 + 321 }} showDaysLeft />);
    expect(screen.getByText('3 years, 321 days left')).toBeInTheDocument();
  });

  it('uses the singular and a zero remainder at exactly one year', () => {
    render(<WarrantyStatusBadge warranty={{ status: 'active', daysLeft: 365 }} showDaysLeft />);
    expect(screen.getByText('1 year, 0 days left')).toBeInTheDocument();
  });

  it('prints years and days for a long-expired warranty', () => {
    render(<WarrantyStatusBadge warranty={{ status: 'expired', daysLeft: -(365 + 1) }} showDaysLeft />);
    expect(screen.getByText('Expired 1 year, 1 day ago')).toBeInTheDocument();
  });

  it('says a warranty expiring today expires today', () => {
    render(<WarrantyStatusBadge warranty={{ status: 'expiring', daysLeft: 0 }} showDaysLeft />);
    expect(screen.getByText('Expiring soon')).toBeInTheDocument();
    expect(screen.getByText('Expires today')).toBeInTheDocument();
  });

  it('says how long ago an expired warranty ended', () => {
    render(<WarrantyStatusBadge warranty={{ status: 'expired', daysLeft: -3 }} showDaysLeft />);
    expect(screen.getByText('Expired 3 days ago')).toBeInTheDocument();
  });

  it('prints no days line for a lifetime warranty', () => {
    const { container } = render(
      <WarrantyStatusBadge warranty={{ status: 'lifetime', daysLeft: null }} showDaysLeft />,
    );
    expect(container.textContent).toBe('Lifetime');
  });

  it('trusts the server status rather than re-deriving it from daysLeft', () => {
    // A status the server sent is what is drawn, even where a client-side
    // window would disagree (WTY-002).
    render(<WarrantyStatusBadge warranty={{ status: 'active', daysLeft: 5 }} showDaysLeft />);
    expect(screen.getByText('Active')).toBeInTheDocument();
    expect(screen.queryByText('Expiring soon')).not.toBeInTheDocument();
  });

  it("formats the day count in the reader's number format", () => {
    usePreferencesStore.setState({ preferences: { numberFormat: 'de-DE' } as never });
    render(<WarrantyStatusBadge warranty={{ status: 'active', daysLeft: 1200 }} showDaysLeft />);
    expect(screen.getByText('3 years, 105 days left')).toBeInTheDocument();
  });
});
