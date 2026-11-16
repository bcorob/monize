import { describe, it, expect, vi } from 'vitest';
import { screen, fireEvent } from '@testing-library/react';
import { render } from '@/test/render';
import { WidgetSegmentedControl } from './WidgetSegmentedControl';

const OPTIONS = [
  { value: 'a', label: 'Alpha' },
  { value: 'b', label: 'Beta' },
] as const;

describe('WidgetSegmentedControl', () => {
  it('renders all options and marks the active one', () => {
    render(
      <WidgetSegmentedControl value="a" onChange={() => {}} options={[...OPTIONS]} />,
    );
    expect(screen.getByText('Alpha')).toHaveClass('bg-blue-600');
    expect(screen.getByText('Beta')).not.toHaveClass('bg-blue-600');
  });

  it('marks the active segment as pressed', () => {
    render(
      <WidgetSegmentedControl value="a" onChange={() => {}} options={[...OPTIONS]} />,
    );
    expect(screen.getByRole('button', { name: 'Alpha' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'Beta' })).toHaveAttribute('aria-pressed', 'false');
  });

  it('draws an icon option as its icon, named and titled by its label', () => {
    render(
      <WidgetSegmentedControl
        value="a"
        onChange={() => {}}
        ariaLabel="View"
        options={[
          { value: 'a', label: 'Alpha', icon: <svg data-testid="alpha-icon" /> },
          { value: 'b', label: 'Beta' },
        ]}
      />,
    );
    const alpha = screen.getByRole('button', { name: 'Alpha' });
    expect(alpha).toHaveTextContent('');
    expect(alpha).toContainElement(screen.getByTestId('alpha-icon'));
    expect(alpha).toHaveAttribute('title', 'Alpha');
    // A label-only segment stays a word, with no tooltip repeating it.
    expect(screen.getByRole('button', { name: 'Beta' })).not.toHaveAttribute('title');
    expect(screen.getByRole('group', { name: 'View' })).toBeInTheDocument();
  });

  it('fires onChange with the clicked value', () => {
    const onChange = vi.fn();
    render(
      <WidgetSegmentedControl value="a" onChange={onChange} options={[...OPTIONS]} />,
    );
    fireEvent.click(screen.getByText('Beta'));
    expect(onChange).toHaveBeenCalledWith('b');
  });
});
