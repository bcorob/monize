import { describe, it, expect } from 'vitest';
import { registerDateColumnPadding } from './register-date-columns';

describe('registerDateColumnPadding', () => {
  it('changes nothing while the full date is shown', () => {
    // The ordinary table inset is what every other column uses; a register
    // showing full dates has no reason to look different from one.
    expect(registerDateColumnPadding(false)).toEqual({ date: '', payee: '' });
    expect(registerDateColumnPadding(undefined)).toEqual({ date: '', payee: '' });
  });

  it('tightens the facing side of each column when the year is hidden', () => {
    const padding = registerDateColumnPadding(true);

    // The gap a reader sees is the date's right inset plus the payee's left
    // inset, so closing it means both -- one alone leaves half the gap.
    expect(padding.date).toContain('pr-1');
    expect(padding.payee).toContain('pl-1');
  });

  it('confines the change to phone widths', () => {
    // Above `sm` the full date renders, so there is nothing to compensate for
    // and the table keeps its ordinary inset.
    const padding = registerDateColumnPadding(true);

    for (const cls of [padding.date, padding.payee]) {
      expect(cls).toMatch(/^max-sm:/);
    }
  });

  it('leaves the outer side of each column alone', () => {
    // Only the sides that face each other move: pulling in the date's left
    // inset would unalign it from the checkbox column beside it.
    const padding = registerDateColumnPadding(true);

    expect(padding.date).not.toContain('pl-');
    expect(padding.payee).not.toContain('pr-');
  });
});
