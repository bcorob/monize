import { describe, it, expect } from 'vitest';
import { render, screen } from '@/test/render';
import { EmptyState } from './EmptyState';

describe('EmptyState', () => {
  it('renders title, description and action', () => {
    render(
      <EmptyState
        title="No transactions"
        description="Add your first transaction to get started."
        action={<button>New Transaction</button>}
      />,
    );
    expect(screen.getByRole('heading', { name: 'No transactions' })).toBeInTheDocument();
    expect(screen.getByText('Add your first transaction to get started.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'New Transaction' })).toBeInTheDocument();
  });

  it('renders the glyph as decoration when given', () => {
    const { container } = render(
      <EmptyState icon={<svg data-testid="glyph" />} title="Empty" />,
    );
    const holder = container.querySelector('[aria-hidden]');
    expect(holder).toBeTruthy();
    expect(holder?.querySelector('svg')).toBeTruthy();
  });

  it('renders no glyph holder without an icon', () => {
    const { container } = render(<EmptyState title="Empty" />);
    expect(container.querySelector('[aria-hidden]')).toBeNull();
  });
});
