import { describe, it, expect } from 'vitest';
import { render, screen, within } from '@/test/render';
import { ParsedReceiptView } from './ParsedReceiptView';
import { PARSED_RECEIPT } from './email-receipts-fixtures';
import { readParsedReceipt } from '@/lib/email-receipts-format';
import type { ParsedReceipt } from '@/types/email-receipts';

const parsed = readParsedReceipt(PARSED_RECEIPT) as ParsedReceipt;
const labels = new Map([['cat-1', 'Electronics: Cables']]);

describe('ParsedReceiptView', () => {
  it('divides every 1/10000 amount by 10000 exactly once', () => {
    render(<ParsedReceiptView parsed={parsed} currencyCode="USD" categoryLabels={labels} />);
    // total 250000 -> 25.00, shipping 50000 -> 5.00, cable line 199800 -> 19.98
    expect(screen.getByText('Total').nextElementSibling).toHaveTextContent('$25.00');
    expect(screen.getByText('Shipping').nextElementSibling).toHaveTextContent('$5.00');
    const row = screen.getByRole('row', { name: /USB-C cable/ });
    expect(within(row).getByText('$19.98')).toBeInTheDocument();
    expect(within(row).getByText('2')).toBeInTheDocument();
    expect(screen.queryByText(/250,000|199,800|\$250000|19980/)).not.toBeInTheDocument();
  });

  it('shows what was paid and the merchant only when the email states them', () => {
    const { rerender } = render(<ParsedReceiptView parsed={parsed} currencyCode="USD" categoryLabels={labels} />);
    expect(screen.queryByText('Paid')).not.toBeInTheDocument();
    expect(screen.queryByText('Merchant')).not.toBeInTheDocument();

    const promo = { ...parsed, total: 249_900, paid: 219_900, payee: 'GRUPA OLX SP. Z O.O.' };
    rerender(<ParsedReceiptView parsed={promo} currencyCode="USD" categoryLabels={labels} />);
    expect(screen.getByText('Paid').nextElementSibling).toHaveTextContent('$21.99');
    expect(screen.getByText('Total').nextElementSibling).toHaveTextContent('$24.99');
    expect(screen.getByText('Merchant').nextElementSibling).toHaveTextContent('GRUPA OLX SP. Z O.O.');
  });

  it('says an item has no amount and no single total to give it', () => {
    const missing = { ...parsed, complete: false, reason: 'item_amount_missing' as const };
    render(<ParsedReceiptView parsed={missing} currencyCode="USD" categoryLabels={labels} />);
    expect(screen.getByText('An item has no amount, and the email has no single total to give it.')).toBeInTheDocument();
  });

  it('shows a figure the email did not state as "Not found", never as a zero', () => {
    render(<ParsedReceiptView parsed={parsed} currencyCode="USD" categoryLabels={labels} />);
    expect(screen.getByText('Discount').nextElementSibling).toHaveTextContent('Not found');
  });

  it('shows a stated zero as a number', () => {
    const free = { ...parsed, shipping: 0 };
    render(<ParsedReceiptView parsed={free} currencyCode="USD" categoryLabels={labels} />);
    expect(screen.getByText('Shipping').nextElementSibling).toHaveTextContent('$0.00');
  });

  it('names categories, and says so for one that is missing or unknown', () => {
    const { rerender } = render(<ParsedReceiptView parsed={parsed} currencyCode="USD" categoryLabels={labels} />);
    expect(screen.getByText('Electronics: Cables')).toBeInTheDocument();
    expect(screen.getByText('No category')).toBeInTheDocument();

    rerender(<ParsedReceiptView parsed={parsed} currencyCode="USD" categoryLabels={new Map()} />);
    expect(screen.getByText('Unknown category')).toBeInTheDocument();

    rerender(<ParsedReceiptView parsed={parsed} currencyCode="USD" categoryLabels={null} />);
    expect(screen.getByText('Categories not loaded')).toBeInTheDocument();
    expect(screen.queryByText('Unknown category')).not.toBeInTheDocument();
  });

  it('says whether the read is complete, and why not', () => {
    const { rerender } = render(<ParsedReceiptView parsed={parsed} currencyCode="USD" categoryLabels={labels} />);
    expect(screen.getByText('Not read completely')).toBeInTheDocument();
    expect(screen.getByText('The line items do not add up to the total.')).toBeInTheDocument();

    rerender(<ParsedReceiptView parsed={{ ...parsed, complete: true, reason: null }} currencyCode="USD" categoryLabels={labels} />);
    expect(screen.getByText('Read completely')).toBeInTheDocument();
    expect(screen.queryByText(/do not add up/)).not.toBeInTheDocument();
  });

  it('says so when no item was read', () => {
    render(<ParsedReceiptView parsed={{ ...parsed, items: [] }} currencyCode="USD" categoryLabels={labels} />);
    expect(screen.getByText('No line items were read.')).toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });

  it('says when the AI read the email, and says nothing for a profile', () => {
    const { rerender } = render(
      <ParsedReceiptView parsed={{ ...parsed, source: 'ai' }} currencyCode="USD" categoryLabels={labels} />,
    );
    expect(screen.getByText('Read by the AI')).toBeInTheDocument();

    rerender(<ParsedReceiptView parsed={{ ...parsed, source: 'parser' }} currencyCode="USD" categoryLabels={labels} />);
    expect(screen.queryByText('Read by the AI')).not.toBeInTheDocument();
    rerender(<ParsedReceiptView parsed={parsed} currencyCode="USD" categoryLabels={labels} />);
    expect(screen.queryByText('Read by the AI')).not.toBeInTheDocument();
  });

  it('says when the email\'s own structured data was read, and not "Read by the AI"', () => {
    const { rerender } = render(
      <ParsedReceiptView parsed={{ ...parsed, source: 'schema_org' }} currencyCode="USD" categoryLabels={labels} />,
    );
    expect(screen.getByText('Read from structured data')).toBeInTheDocument();
    expect(screen.queryByText('Read by the AI')).not.toBeInTheDocument();

    rerender(<ParsedReceiptView parsed={{ ...parsed, source: 'parser' }} currencyCode="USD" categoryLabels={labels} />);
    expect(screen.queryByText('Read from structured data')).not.toBeInTheDocument();
  });
  it('shows the reference the profile read, only when there is one', () => {
    const { rerender } = render(<ParsedReceiptView parsed={parsed} currencyCode="USD" categoryLabels={labels} />);
    expect(screen.queryByText('Reference')).not.toBeInTheDocument();
    rerender(<ParsedReceiptView parsed={{ ...parsed, reference: 'ZX81-4477' }} currencyCode="USD" categoryLabels={labels} />);
    expect(screen.getByText('Reference').nextElementSibling).toHaveTextContent('ZX81-4477');
  });

  it('marks a category the AI chose, and no other', () => {
    const first = parsed.items[0];
    const chosen = { ...parsed, items: [{ ...first, categoryId: 'cat-1', categorySource: 'ai' as const }, ...parsed.items.slice(1)] };
    const { rerender } = render(<ParsedReceiptView parsed={chosen} currencyCode="USD" categoryLabels={labels} />);
    expect(screen.getAllByText('AI')).toHaveLength(1);
    const byRule = { ...parsed, items: [{ ...first, categoryId: 'cat-1' }, ...parsed.items.slice(1)] };
    rerender(<ParsedReceiptView parsed={byRule} currencyCode="USD" categoryLabels={labels} />);
    expect(screen.queryByText('AI')).not.toBeInTheDocument();
  });
});

describe('ParsedReceiptView linked receipts', () => {
  const joined: ParsedReceipt = {
    ...parsed,
    items: [
      { name: 'Laptop', qty: 1, amount: 300_000, categoryId: 'cat-1' },
      { name: 'Delivery', qty: 1, amount: 50_000, categoryId: null, kind: 'shipping' },
      { name: 'Coupon', qty: 1, amount: 20_000, categoryId: null, kind: 'discount' },
      { name: 'Rate', qty: 1, amount: 100_000, categoryId: null, instalment: '2/10' },
    ],
    links: [
      { partIndex: 0, link: 'abc-1', partAmount: 100_000, outcome: 'scaled', componentReceiptId: 'r-1', componentNet: 330_000, taken: 100_000 },
      { partIndex: 1, link: null, partAmount: 20_000, outcome: 'no_link', componentReceiptId: null },
      {
        partIndex: 2,
        link: 'abc-2',
        partAmount: 30_000,
        outcome: 'component_incomplete',
        componentReceiptId: 'r-2',
        componentReason: 'no_total',
      },
    ],
  };

  it('labels shipping and discount lines, shows a discount as negative and an instalment in parentheses', () => {
    render(<ParsedReceiptView parsed={joined} currencyCode="USD" categoryLabels={labels} />);
    const delivery = screen.getByRole('row', { name: /Delivery/ });
    expect(within(delivery).getByText('Shipping')).toBeInTheDocument();
    expect(within(delivery).getByText('$5.00')).toBeInTheDocument();
    const coupon = screen.getByRole('row', { name: /Coupon/ });
    expect(within(coupon).getByText('Discount')).toBeInTheDocument();
    expect(within(coupon).getByText('-$2.00')).toBeInTheDocument();
    expect(screen.getByRole('row', { name: /Rate \(2\/10\)/ })).toBeInTheDocument();
    expect(within(screen.getByRole('row', { name: /Laptop/ })).queryByText('Shipping')).not.toBeInTheDocument();
  });

  it('lists the parts with their link, amount and result', () => {
    render(<ParsedReceiptView parsed={joined} currencyCode="USD" categoryLabels={labels} />);
    expect(screen.getByText('Parts')).toBeInTheDocument();
    const scaled = screen.getByRole('row', { name: /abc-1/ });
    expect(within(scaled).getByText('$10.00')).toBeInTheDocument();
    expect(within(scaled).getByText('Replaced by the lines of the purchase email, scaled to this part.')).toBeInTheDocument();
    expect(within(scaled).getByText(/Purchase total: \$33\.00\. Already used: \$10\.00\./)).toBeInTheDocument();
    const noLink = screen.getByRole('row', { name: /No link/ });
    expect(within(noLink).getByText('The part has no link, so it stays one line.')).toBeInTheDocument();
    const incomplete = screen.getByRole('row', { name: /abc-2/ });
    expect(within(incomplete).getByText('The email states no total.')).toBeInTheDocument();
  });

  it('shows no parts section for a receipt without reports, and the link key of a component', () => {
    const { rerender } = render(<ParsedReceiptView parsed={parsed} currencyCode="USD" categoryLabels={labels} />);
    expect(screen.queryByText('Parts')).not.toBeInTheDocument();
    expect(screen.queryByText('Link key')).not.toBeInTheDocument();
    rerender(<ParsedReceiptView parsed={{ ...parsed, linkKey: 'abc-1' }} currencyCode="USD" categoryLabels={labels} />);
    expect(screen.getByText('Link key').nextElementSibling).toHaveTextContent('abc-1');
  });
});
