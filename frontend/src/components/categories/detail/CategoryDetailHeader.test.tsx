import { describe, it, expect, vi } from 'vitest';
import { screen, fireEvent } from '@testing-library/react';
import { render } from '@/test/render';
import { CategoryDetailHeader } from './CategoryDetailHeader';
import type { Category } from '@/types/category';

function category(overrides: Partial<Category> = {}): Category {
  return {
    id: 'cat-1',
    userId: 'user-1',
    parentId: null,
    parent: null,
    children: [],
    name: 'Groceries',
    description: null,
    icon: null,
    color: null,
    effectiveColor: null,
    effectiveIcon: null,
    isIncome: false,
    isSystem: false,
    createdAt: '2024-01-15T00:00:00.000Z',
    ...overrides,
  };
}

function renderHeader(
  overrides: Partial<Category> = {},
  firstTransactionDate: string | null = null,
  categories: Category[] = [],
  parentName: string | null = null,
) {
  const handlers = {
    onBack: vi.fn(),
    onViewTransactions: vi.fn(),
    onEdit: vi.fn(),
    onDelete: vi.fn(),
    onSelectCategory: vi.fn(),
  };
  const { container } = render(
    <CategoryDetailHeader
      category={category(overrides)}
      parentName={parentName}
      firstTransactionDate={firstTransactionDate}
      categories={categories}
      {...handlers}
    />,
  );
  return { ...handlers, container };
}

describe('CategoryDetailHeader', () => {
  it('titles a top-level category by its bare name', () => {
    renderHeader();
    expect(screen.getByRole('heading', { name: 'Groceries' })).toBeInTheDocument();
  });

  it('titles a subcategory "Parent: Child", like every category picker', () => {
    renderHeader({ name: 'Produce', parentId: 'cat-parent' }, null, [], 'Groceries');
    expect(
      screen.getByRole('heading', { name: 'Groceries: Produce' }),
    ).toBeInTheDocument();
  });

  it('draws the swatch in the category own colour', () => {
    const { container } = renderHeader({ effectiveColor: '#ff8800' });
    const swatch = container.querySelector('span[style]') as HTMLElement;
    expect(swatch).not.toBeNull();
    expect(swatch.style.backgroundColor).toBe('rgb(255, 136, 0)');
  });

  it('shows no swatch when the category has no colour', () => {
    const { container } = renderHeader();
    expect(container.querySelector('span[style]')).toBeNull();
  });

  it('badges an expense category as Expense', () => {
    renderHeader();
    expect(screen.getByText('Expense')).toBeInTheDocument();
    expect(screen.queryByText('Income')).toBeNull();
  });

  it('badges an income category as Income', () => {
    renderHeader({ isIncome: true });
    expect(screen.getByText('Income')).toBeInTheDocument();
    expect(screen.queryByText('Expense')).toBeNull();
  });

  it('fires the action callbacks', () => {
    const handlers = renderHeader();
    fireEvent.click(screen.getByRole('button', { name: 'Back to Categories' }));
    fireEvent.click(screen.getByRole('button', { name: 'View Transactions' }));
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    expect(handlers.onBack).toHaveBeenCalled();
    expect(handlers.onViewTransactions).toHaveBeenCalled();
    expect(handlers.onEdit).toHaveBeenCalled();
    expect(handlers.onDelete).toHaveBeenCalled();
  });

  it('badges a system category and withholds Edit and Delete', () => {
    renderHeader({ isSystem: true });
    expect(screen.getByText('System')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Edit' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Delete' })).toBeNull();
    // Viewing transactions is still allowed -- only mutation is refused.
    expect(screen.getByRole('button', { name: 'View Transactions' })).toBeInTheDocument();
  });

  it('shows the creation date as "since" when there are no transactions', () => {
    renderHeader();
    expect(screen.getByText(/Category since/).textContent).toContain('2024');
  });

  it('uses the first transaction date as "since" when it predates the record', () => {
    renderHeader({}, '2019-03-01');
    expect(screen.getByText(/Category since/).textContent).toContain('2019');
  });

  it('keeps the creation date as "since" when the first transaction came later', () => {
    renderHeader({}, '2025-06-01');
    expect(screen.getByText(/Category since/).textContent).toContain('2024');
  });

  it('jumps to another category through the switcher', () => {
    const other = category({ id: 'cat-2', name: 'Travel' });
    const { onSelectCategory } = renderHeader({}, null, [category(), other]);
    fireEvent.click(screen.getByRole('button', { name: 'Switch category' }));
    fireEvent.click(screen.getByRole('menuitem', { name: /Travel/ }));
    expect(onSelectCategory).toHaveBeenCalledWith('cat-2');
  });
  describe('the category glyph', () => {
    it('draws the icon rather than printing its name', () => {
      // The heading interpolated `category.icon` into text, so picking an icon
      // showed "shopping-cart" beside the name.
      const { container } = renderHeader({
        icon: 'shopping-cart',
        color: '#22c55e',
      });

      expect(screen.queryByText(/shopping-cart/)).toBeNull();
      expect(container.querySelector('svg')).toBeTruthy();
    });

    it('shows the icon inherited from a parent category', () => {
      const { container } = renderHeader({
        icon: null,
        effectiveIcon: 'home',
        color: null,
        effectiveColor: '#22c55e',
      });

      expect(container.querySelector('svg')).toBeTruthy();
    });
  });
});
