import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@/test/render';
import { BrandLogo } from './BrandLogo';

describe('BrandLogo', () => {
  it('renders the cached image when a source is given', () => {
    render(<BrandLogo src="/api/v1/payees/p-1/logo" name="Starbucks" />);
    const img = screen.getByAltText('Starbucks') as HTMLImageElement;
    expect(img.getAttribute('src')).toBe('/api/v1/payees/p-1/logo');
  });

  it('falls back to the initial badge when there is no source', () => {
    render(<BrandLogo src={null} name="Starbucks" />);
    expect(screen.queryByRole('img')).toBeNull();
    expect(screen.getByText('S')).toBeInTheDocument();
  });

  it('falls back to the badge when the image fails to load', () => {
    // A 404 from the logo route (no icon cached yet, or the fetch failed) has
    // to look the same to the reader as having no icon at all.
    render(<BrandLogo src="/api/v1/payees/p-1/logo" name="Starbucks" />);
    fireEvent.error(screen.getByAltText('Starbucks'));
    expect(screen.queryByRole('img')).toBeNull();
    expect(screen.getByText('S')).toBeInTheDocument();
  });

  it('retries for a different entity after a failure', () => {
    // The error flag belongs to the image that failed; keeping it across a
    // switch would leave the next payee permanently badged.
    const { rerender } = render(
      <BrandLogo src="/api/v1/payees/p-1/logo" name="Starbucks" />,
    );
    fireEvent.error(screen.getByAltText('Starbucks'));
    rerender(<BrandLogo src="/api/v1/payees/p-2/logo" name="Amazon" />);
    expect((screen.getByAltText('Amazon') as HTMLImageElement).src).toContain(
      '/payees/p-2/logo',
    );
  });

  it('uses the glyph when there is no name to take an initial from', () => {
    render(<BrandLogo src={null} name={null} fallbackGlyph="$" />);
    expect(screen.getByText('$')).toBeInTheDocument();
  });

  it('prefers a supplied fallback icon over the glyph', () => {
    const { container } = render(
      <BrandLogo src={null} name={null} fallbackIcon={<svg data-testid="i" />} />,
    );
    expect(container.querySelector('svg')).toBeTruthy();
  });
});
