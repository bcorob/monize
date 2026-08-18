import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@/test/render';
import { NextIntlClientProvider } from 'next-intl';
import { ListTopToolbar } from './ListTopToolbar';
import { useDensityStore } from '@/store/densityStore';
import commonNs from '@/i18n/messages/en/common.json';

function renderToolbar(ui: React.ReactElement) {
  return render(
    <NextIntlClientProvider locale="en" messages={{ common: commonNs }}>
      {ui}
    </NextIntlClientProvider>,
  );
}

const PAGING = {
  currentPage: 2,
  totalPages: 4,
  totalItems: 90,
  pageSize: 25,
};

describe('ListTopToolbar', () => {
  beforeEach(() => {
    useDensityStore.setState({ densities: { transactions: 'normal' } });
  });

  it('says where in the list the reader is', () => {
    renderToolbar(
      <ListTopToolbar densityView="transactions" {...PAGING} onPageChange={vi.fn()} itemName="transactions" />,
    );

    expect(screen.getByText('26')).toBeInTheDocument();
    expect(screen.getByText('50')).toBeInTheDocument();
    expect(screen.getByText('90')).toBeInTheDocument();
  });

  it('pages from the bar', () => {
    const onPageChange = vi.fn();
    renderToolbar(
      <ListTopToolbar densityView="transactions" {...PAGING} onPageChange={onPageChange} />,
    );

    fireEvent.click(screen.getByTitle('Next page'));

    expect(onPageChange).toHaveBeenCalledWith(3);
  });

  it('carries the density toggle whether or not there is a pager', () => {
    const { unmount } = renderToolbar(
      <ListTopToolbar densityView="transactions" {...PAGING} onPageChange={vi.fn()} />,
    );
    expect(screen.getByTitle('Toggle row density')).toBeInTheDocument();
    unmount();

    renderToolbar(<ListTopToolbar densityView="transactions" />);
    expect(screen.getByTitle('Toggle row density')).toBeInTheDocument();
  });

  it('keeps the count on a single page, which is where a filter lands', () => {
    // "Showing 1-7 of 7" is the answer to "did that filter work?", so hiding it
    // exactly when a filter has narrowed the list to one page takes the count
    // away at the moment it is being read.
    renderToolbar(
      <ListTopToolbar
        densityView="transactions"
        currentPage={1}
        totalPages={1}
        totalItems={7}
        pageSize={25}
        onPageChange={vi.fn()}
        itemName="transactions"
      />,
    );

    // The line is assembled from several nodes, so it is matched as text.
    expect(document.body.textContent).toContain('Showing');
    expect(document.body.textContent).toContain('of');
    expect(screen.getAllByText('7').length).toBeGreaterThan(0);
    expect(screen.getByTitle('Next page')).toBeDisabled();
  });

  it('draws no pager when the paging props are not supplied', () => {
    renderToolbar(<ListTopToolbar densityView="transactions" />);

    expect(screen.queryByTitle('Next page')).not.toBeInTheDocument();
  });

  it('puts the list its own buttons beside the toggle', () => {
    renderToolbar(
      <ListTopToolbar
        densityView="transactions"
        {...PAGING}
        onPageChange={vi.fn()}
        actions={<button>Export</button>}
      />,
    );

    expect(screen.getByText('Export')).toBeInTheDocument();
  });
});
