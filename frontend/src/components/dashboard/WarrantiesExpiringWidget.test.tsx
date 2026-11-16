import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, screen } from '@testing-library/react';
import { render } from '@/test/render';
import { WarrantiesExpiringWidget } from './WarrantiesExpiringWidget';
import type { Warranty } from '@/types/warranty';

const listMock = vi.fn();
vi.mock('@/lib/warranties', () => ({
  warrantiesApi: { list: (...args: unknown[]) => listMock(...args) },
}));

async function renderWidget(parentLoading = false) {
  await act(async () => {
    render(<WarrantiesExpiringWidget isLoading={parentLoading} />);
  });
}

function warranty(over: Partial<Warranty>): Warranty {
  return {
    id: 'w1',
    name: 'Dishwasher',
    vendorName: 'Home Depot',
    payeeId: null,
    payee: null,
    expiresOn: '2026-11-05',
    status: 'expiring',
    daysLeft: 15,
    isLifetime: false,
    ...over,
  } as Warranty;
}

describe('WarrantiesExpiringWidget', () => {
  beforeEach(() => {
    listMock.mockReset();
  });

  it('shows the skeleton without fetching while the parent loads', async () => {
    listMock.mockResolvedValue({ data: [], pagination: {} });
    await renderWidget(true);
    expect(listMock).not.toHaveBeenCalled();
    expect(screen.getByText('Warranties expiring soon')).toBeInTheDocument();
  });

  it('asks the server for the five soonest expiring warranties', async () => {
    listMock.mockResolvedValue({ data: [], pagination: {} });
    await renderWidget();
    expect(listMock).toHaveBeenCalledWith({ status: 'expiring', limit: 5, sort: 'expiresOn' });
    expect(screen.getByRole('link', { name: 'Warranties expiring soon' })).toHaveAttribute('href', '/warranties');
  });

  it('renders the server status, days left and date, each row linking to the detail', async () => {
    listMock.mockResolvedValue({
      data: [
        warranty({}),
        warranty({ id: 'w2', name: 'Laptop', vendorName: null, daysLeft: 0, expiresOn: '2026-10-21' }),
      ],
      pagination: {},
    });
    await renderWidget();

    expect(screen.getByText('Dishwasher')).toBeInTheDocument();
    expect(screen.getByText('Home Depot')).toBeInTheDocument();
    expect(screen.getByText('15 days left')).toBeInTheDocument();
    expect(screen.getByText('Expires today')).toBeInTheDocument();
    expect(screen.getAllByText('Expiring soon').length).toBeGreaterThan(0);
    expect(screen.getByRole('link', { name: /Dishwasher/ })).toHaveAttribute('href', '/warranties/w1');
    expect(screen.getByRole('link', { name: /Laptop/ })).toHaveAttribute('href', '/warranties/w2');
  });

  it("draws the vendor's logo from the view's payee, and the initial for a typed vendor", async () => {
    listMock.mockResolvedValue({
      data: [
        warranty({ payeeId: 'p-1', payee: { id: 'p-1', name: 'Home Depot', hasLogo: true } }),
        warranty({ id: 'w2', name: 'Laptop', vendorName: 'Corner shop' }),
        warranty({ id: 'w3', name: 'Kettle', vendorName: null }),
      ],
      pagination: {},
    });
    await renderWidget();

    const logos = screen.getAllByRole('img');
    expect(logos).toHaveLength(1);
    expect(logos[0]).toHaveAttribute('src', '/api/v1/payees/p-1/logo');
    expect(screen.getByText('Home Depot').parentElement?.firstElementChild).toBe(logos[0]);
    expect(screen.getByText('Corner shop').parentElement).toHaveTextContent('CCorner shop');
    expect(screen.getByRole('link', { name: /Kettle/ }).querySelector('[aria-hidden="true"]')).toBeNull();
  });

  it('renders at most five rows', async () => {
    listMock.mockResolvedValue({
      data: Array.from({ length: 7 }, (_, i) => warranty({ id: `w${i}`, name: `Item ${i}` })),
      pagination: {},
    });
    await renderWidget();
    expect(screen.getAllByRole('listitem')).toHaveLength(5);
  });

  it('shows the empty state when nothing is expiring', async () => {
    listMock.mockResolvedValue({ data: [], pagination: {} });
    await renderWidget();
    expect(screen.getByText('Nothing expires in the next 30 days')).toBeInTheDocument();
  });

  it('shows an error state, not the empty state, when the load fails', async () => {
    listMock.mockRejectedValue(new Error('boom'));
    await renderWidget();
    expect(screen.getByRole('alert')).toHaveTextContent("Couldn't load your expiring warranties");
    expect(screen.queryByText('Nothing expires in the next 30 days')).not.toBeInTheDocument();
  });
});
