import { describe, it, expect } from 'vitest';
import { render, screen } from '@/test/render';
import { StructuredOrderView } from './StructuredOrderView';
import type { SchemaOrgOrder } from '@/types/email-receipts';

const order = (over: Partial<SchemaOrgOrder> = {}): SchemaOrgOrder => ({
  orderNumber: 'EX-123',
  seller: 'Example Shop',
  currency: 'USD',
  orderDate: '2026-05-04T10:00:00-08:00',
  total: 150_000,
  discount: null,
  items: [
    { name: 'Widget', qty: 2, unitPrice: 60_000, amount: 120_000 },
    { name: 'Gadget', qty: 1, unitPrice: null, amount: null },
  ],
  ...over,
});

describe('StructuredOrderView', () => {
  it('says not found, and why, when the email carries no order', () => {
    render(<StructuredOrderView order={null} />);
    expect(screen.getByText('Not found')).toBeInTheDocument();
    expect(screen.getByText('The email carries no order markup, or it states no total and no line items.')).toBeInTheDocument();
    expect(screen.queryByText('Found')).not.toBeInTheDocument();
  });

  it('shows the order the markup describes, converting the 1/10000 units once', () => {
    render(<StructuredOrderView order={order()} />);
    expect(screen.getByText('Found')).toBeInTheDocument();
    expect(screen.getByText('EX-123')).toBeInTheDocument();
    expect(screen.getByText('Example Shop')).toBeInTheDocument();
    // total 150000 units is 15.00, never 150000 and never 1.50
    expect(screen.getAllByText('$15.00').length).toBeGreaterThan(0);
    expect(screen.getByText('Widget')).toBeInTheDocument();
    expect(screen.getByText('$6.00')).toBeInTheDocument();
    expect(screen.getByText('$12.00')).toBeInTheDocument();
    expect(screen.getByText('2026-05-04T10:00:00-08:00')).toBeInTheDocument();
  });

  it('shows a figure the markup did not state as not found, never as zero', () => {
    render(<StructuredOrderView order={order({ total: null, orderNumber: null, seller: null })} />);
    // order number, seller, total, discount, and the item without a price (twice)
    expect(screen.getAllByText('Not found').length).toBeGreaterThanOrEqual(6);
    expect(screen.queryByText('$0.00')).not.toBeInTheDocument();
  });

  it('shows a stated zero discount as an amount', () => {
    render(<StructuredOrderView order={order({ discount: 0 })} />);
    expect(screen.getByText('$0.00')).toBeInTheDocument();
  });

  it('says so when the order has no line items', () => {
    render(<StructuredOrderView order={order({ items: [] })} />);
    expect(screen.getByText('No line items were read.')).toBeInTheDocument();
  });

  it('shows markup in a name as characters', () => {
    render(<StructuredOrderView order={order({ seller: '<img src=x onerror=alert(1)>' })} />);
    expect(screen.getByText('<img src=x onerror=alert(1)>')).toBeInTheDocument();
    expect(document.querySelector('img')).toBeNull();
  });
});
