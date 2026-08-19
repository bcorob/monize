import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@/test/render';
import { ListBottomPager } from './ListBottomPager';

describe('ListBottomPager', () => {
  const paged = {
    currentPage: 2,
    totalPages: 4,
    totalItems: 90,
    pageSize: 25,
    onPageChange: vi.fn(),
    itemName: 'transactions',
    totalLabel: '90 transactions',
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('draws the pager when there is more than one page', () => {
    const { container } = render(<ListBottomPager {...paged} />);
    expect(screen.getByTitle('First page')).toBeInTheDocument();
    expect(screen.getByTitle('Last page')).toBeInTheDocument();
    // The position line names the range and the caller's noun.
    expect(container.textContent).toContain('26');
    expect(container.textContent).toContain('50');
    expect(container.textContent).toContain('90');
    expect(container.textContent).toContain('transactions');
  });

  // An inert pager at the end of a list says nothing; the count does. The strip
  // above the rows keeps its pager for the opposite reason -- see the comment
  // on `ListTopToolbar`.
  it('draws the count instead of an inert pager on a single page', () => {
    render(
      <ListBottomPager {...paged} currentPage={1} totalPages={1} totalItems={7} totalLabel="7 transactions" />,
    );
    expect(screen.getByText('7 transactions')).toBeInTheDocument();
    expect(screen.queryByTitle('First page')).not.toBeInTheDocument();
  });

  // The empty state above already said so, and "0 transactions" under it would
  // be the same sentence twice.
  it('draws nothing for an empty list', () => {
    const { container } = render(
      <ListBottomPager {...paged} currentPage={1} totalPages={1} totalItems={0} totalLabel="0 transactions" />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  // Half a pager built from whichever props arrived is worse than none: the
  // surrounding surface owns the paging in that case.
  it('draws nothing when the paging state is incomplete', () => {
    const { container } = render(
      <ListBottomPager
        currentPage={1}
        pageSize={25}
        onPageChange={vi.fn()}
        itemName="transactions"
        totalLabel="90 transactions"
      />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('draws nothing while the page has no pagination payload yet', () => {
    const { container } = render(
      <ListBottomPager
        currentPage={1}
        totalPages={undefined}
        totalItems={undefined}
        pageSize={25}
        onPageChange={vi.fn()}
        itemName="transactions"
        totalLabel="0 transactions"
      />,
    );
    expect(container).toBeEmptyDOMElement();
  });
});
