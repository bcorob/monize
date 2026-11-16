import { describe, it, expect } from 'vitest';
import { render, screen } from '@/test/render';
import { BackToSettingsLink } from './BackToSettingsLink';

describe('BackToSettingsLink', () => {
  it('links back to Settings with a chevron, not a text arrow', () => {
    const { container } = render(<BackToSettingsLink label="Back to Settings" />);

    const link = screen.getByRole('link', { name: 'Back to Settings' });
    expect(link).toHaveAttribute('href', '/settings');
    expect(link.querySelector('svg[aria-hidden="true"]')).not.toBeNull();
    expect(container.textContent).not.toContain('←');
  });
});
