import { describe, it, expect, vi } from 'vitest';
import { screen, fireEvent } from '@testing-library/react';
import { render } from '@/test/render';
import { TagKeyBreakdownSelect } from './TagKeyBreakdownSelect';

describe('TagKeyBreakdownSelect', () => {
  it('renders nothing when the user has no KEY:VALUE tags', () => {
    const { container } = render(
      <TagKeyBreakdownSelect tagKeys={[]} value="" onChange={vi.fn()} />,
    );
    expect(container.firstChild).toBeNull();
  });

  it('offers "None" plus each discovered key, defaulting to "None"', () => {
    render(
      <TagKeyBreakdownSelect tagKeys={['scope', 'project']} value="" onChange={vi.fn()} />,
    );
    const select = screen.getByRole('combobox', { name: 'Break down by tag key' }) as HTMLSelectElement;
    expect(select.value).toBe('');
    expect(screen.getByRole('option', { name: 'None' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'scope' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'project' })).toBeInTheDocument();
  });

  it('reports the chosen key, and empty ("None") when cleared', () => {
    const onChange = vi.fn();
    render(
      <TagKeyBreakdownSelect tagKeys={['scope']} value="" onChange={onChange} />,
    );
    const select = screen.getByRole('combobox', { name: 'Break down by tag key' });
    fireEvent.change(select, { target: { value: 'scope' } });
    expect(onChange).toHaveBeenCalledWith('scope');

    fireEvent.change(select, { target: { value: '' } });
    expect(onChange).toHaveBeenCalledWith('');
  });
});
