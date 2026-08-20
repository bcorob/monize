import { describe, it, expect } from 'vitest';
import { render, screen } from '@/test/render';
import { CategoryGlyph } from './CategoryGlyph';

describe('CategoryGlyph', () => {
  it('renders the icon as a glyph, never as its name', () => {
    // The detail pages used to interpolate `category.icon` into the heading,
    // so a picked icon read as the literal text "shopping-cart".
    const { container } = render(<CategoryGlyph icon="shopping-cart" color="#22c55e" />);
    expect(container.querySelector('svg')).toBeTruthy();
    expect(screen.queryByText('shopping-cart')).toBeNull();
  });

  it('tints the icon with the effective colour', () => {
    const { container } = render(<CategoryGlyph icon="home" color="#22c55e" />);
    const glyph = container.firstElementChild as HTMLElement;
    expect(glyph.style.color).toBe('rgb(34, 197, 94)');
  });

  it('falls back to the colour dot when no icon is set', () => {
    const { container } = render(<CategoryGlyph icon={null} color="#22c55e" />);
    const dot = container.firstElementChild as HTMLElement;
    expect(container.querySelector('svg')).toBeNull();
    expect(dot.style.backgroundColor).toBe('rgb(34, 197, 94)');
  });

  it('renders nothing when the category has neither', () => {
    const { container } = render(<CategoryGlyph icon={null} color={null} />);
    expect(container.firstElementChild).toBeNull();
  });

  it('dims a value that came from an ancestor', () => {
    const { container } = render(<CategoryGlyph icon="home" color="#22c55e" inherited />);
    expect((container.firstElementChild as HTMLElement).className).toContain('opacity-50');
  });
});
