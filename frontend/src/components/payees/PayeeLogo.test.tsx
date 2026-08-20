import { describe, it, expect } from 'vitest';
import { render, screen } from '@/test/render';
import { PayeeLogo } from './PayeeLogo';

const payee = { id: 'payee-1', name: 'Starbucks', hasLogo: true };

describe('PayeeLogo', () => {
  it('reads the payee logo route when an icon is cached', () => {
    render(<PayeeLogo payee={payee} />);
    const img = screen.getByAltText('Starbucks') as HTMLImageElement;
    expect(img.getAttribute('src')).toBe('/api/v1/payees/payee-1/logo');
  });

  it('never requests an image when no icon is cached', () => {
    // hasLogo is what spares every list row a guaranteed 404.
    render(<PayeeLogo payee={{ ...payee, hasLogo: false }} />);
    expect(screen.queryByRole('img')).toBeNull();
    expect(screen.getByText('S')).toBeInTheDocument();
  });

  it('renders the fallback badge with no payee at all', () => {
    render(<PayeeLogo payee={null} fallbackGlyph="$" />);
    expect(screen.getByText('$')).toBeInTheDocument();
  });
});
