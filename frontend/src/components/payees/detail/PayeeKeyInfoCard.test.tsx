import { describe, it, expect, vi } from 'vitest';
import { screen, fireEvent } from '@testing-library/react';
import { render } from '@/test/render';
import { PayeeKeyInfoCard } from './PayeeKeyInfoCard';
import type { PayeeDetail } from '@/types/payee';

function detailFixture(overrides: Partial<PayeeDetail> = {}): PayeeDetail {
  return {
    payee: {
      id: 'payee-1',
      userId: 'user-1',
      name: 'Hydro One',
      defaultCategoryId: 'cat-1',
      defaultCategory: {
        id: 'cat-1',
        name: 'Utilities',
      } as PayeeDetail['payee']['defaultCategory'],
      notes: 'Electricity provider',
      website: null,
      hasLogo: false,
      logoFetchedAt: null,
      isActive: true,
      createdAt: '2024-01-15T00:00:00.000Z',
    },
    stats: {
      transactionCount: 24,
      firstTransactionDate: '2024-02-01',
      lastTransactionDate: '2026-07-01',
      uncategorizedCount: 0,
      aliasCount: 3,
    },
    accounts: [],
    largestTransaction: {
      id: 'tx-1',
      transactionDate: '2025-12-24',
      amount: -412.5,
      currencyCode: 'CAD',
      accountId: 'acct-1',
      accountName: 'Chequing',
      description: null,
    },
    overpaymentForAccounts: [{ accountId: 'acct-loan', accountName: 'Mortgage' }],
    ...overrides,
  };
}

/** Hierarchical labels, as the page builds them from the category tree. */
const categoryLabelMap = new Map([['cat-1', 'Utilities: Hydro']]);

function renderCard(detail = detailFixture(), labels = categoryLabelMap) {
  const onSelectDate = vi.fn();
  const onSelectAccount = vi.fn();
  render(
    <PayeeKeyInfoCard
      detail={detail}
      categoryLabelMap={labels}
      onSelectDate={onSelectDate}
      onSelectAccount={onSelectAccount}
    />,
  );
  return { onSelectDate, onSelectAccount };
}

describe('PayeeKeyInfoCard', () => {
  it('shows the reference facts', () => {
    renderCard();
    expect(screen.getByText('Key Information')).toBeInTheDocument();
    expect(screen.getByText('Active')).toBeInTheDocument();
    expect(screen.getByText('3')).toBeInTheDocument();
    expect(screen.getByText('Electricity provider')).toBeInTheDocument();
  });

  it('shows the default category with its parent, not the bare leaf', () => {
    renderCard();
    expect(screen.getByText('Utilities: Hydro')).toBeInTheDocument();
    expect(screen.queryByText('Utilities')).toBeNull();
  });

  it('falls back to the relation name when the map has no entry', () => {
    renderCard(detailFixture(), new Map());
    expect(screen.getByText('Utilities')).toBeInTheDocument();
  });

  it('filters the register to the largest transaction own date', () => {
    const { onSelectDate } = renderCard();
    fireEvent.click(screen.getByRole('button', { name: /412\.50/ }));
    expect(onSelectDate).toHaveBeenCalledWith('2025-12-24');
  });

  it('links the overpayment designation to the loan account', () => {
    const { onSelectAccount } = renderCard();
    fireEvent.click(screen.getByRole('button', { name: 'Mortgage' }));
    expect(onSelectAccount).toHaveBeenCalledWith('acct-loan');
  });

  it('drops rows that have no value', () => {
    renderCard(
      detailFixture({
        payee: {
          id: 'payee-1',
          userId: 'user-1',
          name: 'Hydro One',
          defaultCategoryId: null,
          defaultCategory: null,
          notes: null,
          website: null,
          hasLogo: false,
          logoFetchedAt: null,
          isActive: true,
          createdAt: '2024-01-15T00:00:00.000Z',
        },
        stats: {
          transactionCount: 0,
          firstTransactionDate: null,
          lastTransactionDate: null,
          uncategorizedCount: 0,
          aliasCount: 0,
        },
        largestTransaction: null,
        overpaymentForAccounts: [],
      }),
    );
    expect(screen.queryByText('Default Category')).toBeNull();
    expect(screen.queryByText('First Transaction')).toBeNull();
    expect(screen.queryByText('Largest Transaction')).toBeNull();
    expect(screen.queryByText('Overpayment Payee For')).toBeNull();
    expect(screen.queryByText('Notes')).toBeNull();
  });
});
