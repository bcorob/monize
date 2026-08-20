import { describe, it, expect, vi } from 'vitest';
import { screen, fireEvent } from '@testing-library/react';
import { render } from '@/test/render';
import { CategorySwitcher } from './CategorySwitcher';
import type { Category } from '@/types/category';

function category(
  id: string,
  name: string,
  overrides: Partial<Category> = {},
): Category {
  return {
    id,
    userId: 'user-1',
    parentId: null,
    parent: null,
    children: [],
    name,
    description: null,
    icon: null,
    color: null,
    effectiveColor: null,
    effectiveIcon: null,
    isIncome: false,
    isSystem: false,
    createdAt: '2024-01-01T00:00:00.000Z',
    ...overrides,
  };
}

const food = category('cat-food', 'Food');
const coffee = category('cat-coffee', 'Coffee', { parentId: 'cat-food' });
const salary = category('cat-salary', 'Salary', { isIncome: true });
const travel = category('cat-travel', 'Travel');

const all = [food, coffee, salary, travel];

function open(categories: Category[], currentId = 'cat-travel') {
  const onSelect = vi.fn();
  render(
    <CategorySwitcher currentId={currentId} categories={categories} onSelect={onSelect} />,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Switch category' }));
  return { onSelect };
}

describe('CategorySwitcher', () => {
  it('renders nothing when there is no other category to switch to', () => {
    render(
      <CategorySwitcher currentId="cat-travel" categories={[travel]} onSelect={vi.fn()} />,
    );
    expect(screen.queryByRole('button', { name: 'Switch category' })).toBeNull();
  });

  it('lists the other categories, not the current one', () => {
    open(all);
    expect(screen.getByRole('menuitem', { name: /Coffee/ })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: /Salary/ })).toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: /Travel/ })).toBeNull();
  });

  it('labels a child "Parent: Child", exactly as the transaction form dropdown does', () => {
    open(all);
    expect(screen.getByRole('menuitem', { name: 'Food: Coffee' })).toBeInTheDocument();
    // A top-level category is its bare name, not qualified by anything.
    expect(screen.getByRole('menuitem', { name: 'Salary' })).toBeInTheDocument();
  });

  it('lists the categories in tree order: each parent followed by its children', () => {
    open(all);
    const labels = screen.getAllByRole('menuitem').map((item) => item.textContent);
    expect(labels).toEqual(['Food', 'Food: Coffee', 'Salary']);
  });

  it('selects a subcategory and closes', () => {
    const { onSelect } = open(all);
    fireEvent.click(screen.getByRole('menuitem', { name: 'Food: Coffee' }));
    expect(onSelect).toHaveBeenCalledWith('cat-coffee');
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('lets a top-level parent be picked, even from its own child\'s page', () => {
    const { onSelect } = open(all, 'cat-coffee');
    fireEvent.click(screen.getByRole('menuitem', { name: 'Food' }));
    expect(onSelect).toHaveBeenCalledWith('cat-food');
  });

  it('filters a long list on the hierarchical label, not the bare leaf', () => {
    // Several parents can own a "Fees" leaf; the filter must tell them apart.
    const bank = category('cat-bank', 'Banking');
    const invest = category('cat-invest', 'Investments');
    const bankFees = category('cat-bank-fees', 'Fees', { parentId: 'cat-bank' });
    const investFees = category('cat-invest-fees', 'Fees', { parentId: 'cat-invest' });
    const filler = Array.from({ length: 8 }, (_, index) =>
      category(`cat-filler-${index}`, `Filler ${index}`),
    );
    open([bank, invest, bankFees, investFees, ...filler, travel]);
    fireEvent.change(screen.getByPlaceholderText('Filter categories...'), {
      target: { value: 'banking: fees' },
    });
    const matches = screen.getAllByRole('menuitem');
    expect(matches).toHaveLength(1);
    expect(matches[0].textContent).toContain('Fees');
    expect(matches[0].textContent).toContain('Banking');
  });

  it('says when nothing matches the filter', () => {
    const filler = Array.from({ length: 10 }, (_, index) =>
      category(`cat-filler-${index}`, `Filler ${index}`),
    );
    open([...filler, travel]);
    fireEvent.change(screen.getByPlaceholderText('Filter categories...'), {
      target: { value: 'zzz' },
    });
    expect(screen.getByText('No categories match')).toBeInTheDocument();
  });
});
