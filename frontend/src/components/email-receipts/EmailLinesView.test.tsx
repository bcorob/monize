import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent, within } from '@/test/render';
import { EmailLinesView } from './EmailLinesView';

const lines = {
  text: ['Order number: A-1', 'Widget 12,00 zł'],
  html: ['Order number:', 'A-1', 'Widget', '12,00 zł'],
};

describe('EmailLinesView', () => {
  it('shows the text lines, numbered from 1, by default', () => {
    render(<EmailLinesView lines={lines} />);
    const list = screen.getByRole('list', { name: 'Numbered lines of the email' });
    const items = within(list).getAllByRole('listitem');
    expect(items).toHaveLength(2);
    expect(items[0]).toHaveTextContent('1Order number: A-1');
    expect(items[1]).toHaveTextContent('2Widget 12,00 zł');
    expect(screen.getByRole('button', { name: 'Text' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'HTML' })).toHaveAttribute('aria-pressed', 'false');
  });

  it('switches to the lines of the HTML part, which number differently', () => {
    render(<EmailLinesView lines={lines} />);
    fireEvent.click(screen.getByRole('button', { name: 'HTML' }));
    const items = within(screen.getByRole('list', { name: 'Numbered lines of the email' })).getAllByRole('listitem');
    expect(items.map((item) => item.textContent)).toEqual(['1Order number:', '2A-1', '3Widget', '412,00 zł']);
    expect(screen.getByRole('button', { name: 'HTML' })).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(screen.getByRole('button', { name: 'Text' }));
    expect(within(screen.getByRole('list')).getAllByRole('listitem')).toHaveLength(2);
  });

  it('makes the HTML source unavailable, and says why, for an email with no HTML part', () => {
    render(<EmailLinesView lines={{ text: ['a'], html: null }} />);
    const html = screen.getByRole('button', { name: 'HTML' });
    expect(html).toBeDisabled();
    expect(screen.getByText('This email has no HTML part, so a profile that reads HTML cannot read it.')).toBeInTheDocument();
    fireEvent.click(html);
    expect(screen.getByRole('button', { name: 'Text' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('says so when a source has no lines', () => {
    render(<EmailLinesView lines={{ text: [], html: [] }} />);
    expect(screen.getByText('No lines.')).toBeInTheDocument();
    expect(screen.queryByRole('list')).not.toBeInTheDocument();
  });

  it('notes the cap when a source reaches it', () => {
    const many = Array.from({ length: 2000 }, (_, i) => `line ${i}`);
    render(<EmailLinesView lines={{ text: many, html: null }} />);
    expect(screen.getByText('Only the first 2000 lines are read.')).toBeInTheDocument();
  });

  it('shows markup in a line as characters, never as elements', () => {
    render(<EmailLinesView lines={{ text: ['<b>bold</b> <img src=x onerror=alert(1)>'], html: null }} />);
    const list = screen.getByRole('list');
    expect(list.textContent).toContain('<b>bold</b> <img src=x onerror=alert(1)>');
    expect(list.querySelector('b, img')).toBeNull();
  });
});
