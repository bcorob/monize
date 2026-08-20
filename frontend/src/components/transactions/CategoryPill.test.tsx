import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@/test/render';
import { CategoryPill } from './CategoryPill';

describe('CategoryPill', () => {
  it('renders the category icon when one is set', () => {
    const { container } = render(
      <CategoryPill name="Groceries" color="#22c55e" icon="shopping-cart" density="normal" />,
    );
    expect(screen.getByText('Groceries')).toBeInTheDocument();
    expect(container.querySelector('svg')).toBeTruthy();
  });

  it('renders no glyph when the category has no icon', () => {
    // An unset icon must render nothing -- not a broken or default glyph.
    const { container } = render(
      <CategoryPill name="Groceries" color="#22c55e" icon={null} density="normal" />,
    );
    expect(container.querySelector('svg')).toBeNull();
  });

  it('is a button when clickable and a chip otherwise', () => {
    const onClick = vi.fn();
    const { rerender } = render(
      <CategoryPill name="Groceries" color={null} density="normal" onClick={onClick} />,
    );
    fireEvent.click(screen.getByRole('button', { name: /Groceries/ }));
    expect(onClick).toHaveBeenCalled();
    rerender(<CategoryPill name="Groceries" color={null} density="normal" />);
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('keeps the neutral pill for a colourless category', () => {
    render(<CategoryPill name="Misc" color={null} density="dense" />);
    const pill = screen.getByText('Misc').parentElement as HTMLElement;
    expect(pill.style.backgroundColor).toContain('--category-bg-base');
  });
});
