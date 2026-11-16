import { describe, it, expect } from 'vitest';
import { render, screen } from '@/test/render';
import type { Warranty } from '@/types/warranty';
import { WarrantySummaryCards } from './WarrantySummaryCards';

function warranty(overrides: Partial<Warranty> = {}): Warranty {
  return {
    id: 'w-1',
    name: 'Laptop',
    vendorName: 'Best Buy',
    payeeId: null,
    payee: null,
    modelNumber: null,
    serialNumbers: [],
    warrantyKind: 'extended',
    purchaseDate: '2026-10-01',
    expiresOn: '2028-10-01',
    isLifetime: false,
    purchasePrice: 1299.99,
    currencyCode: 'CAD',
    productUrl: null,
    notes: null,
    today: '2026-10-21',
    status: 'active',
    daysLeft: 711,
    documentCount: 0,
    openClaimCount: 2,
    linkedTransactionHidden: false,
    linkedTransaction: null,
    archivedAt: null,
    createdAt: '2026-10-01T00:00:00Z',
    updatedAt: '2026-10-01T00:00:00Z',
    ...overrides,
  };
}

describe('WarrantySummaryCards', () => {
  it('shows expiry with the time left, the purchase date, the price in its currency and the open claims', () => {
    render(<WarrantySummaryCards warranty={warranty()} />);
    const expires = screen.getByRole('article', { name: 'Expires' });
    expect(expires).toHaveTextContent('10/01/2028');
    expect(expires).toHaveTextContent('1 year, 346 days left');
    expect(screen.getByRole('article', { name: 'Purchased' })).toHaveTextContent('10/01/2026');
    expect(screen.getByRole('article', { name: 'Purchase Price' })).toHaveTextContent('$1,299.99 CAD');
    expect(screen.getByRole('article', { name: 'Open Claims' })).toHaveTextContent('2');
  });

  it('says Lifetime with no time left for a lifetime warranty', () => {
    render(<WarrantySummaryCards warranty={warranty({ isLifetime: true, expiresOn: null, status: 'lifetime', daysLeft: null })} />);
    const expires = screen.getByRole('article', { name: 'Expires' });
    expect(expires).toHaveTextContent('Lifetime');
    expect(expires).not.toHaveTextContent(/left/);
  });

  it('says None for a price that was not recorded, never a zero', () => {
    render(<WarrantySummaryCards warranty={warranty({ purchasePrice: null, currencyCode: null })} />);
    expect(screen.getByRole('article', { name: 'Purchase Price' })).toHaveTextContent('None');
  });
});
