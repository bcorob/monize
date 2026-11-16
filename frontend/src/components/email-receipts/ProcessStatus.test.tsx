import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@/test/render';
import { ProcessStatus } from './ProcessStatus';

describe('ProcessStatus', () => {
  it('lists the emails a profile deleted after the states the others ended in', () => {
    render(
      <ProcessStatus
        state={{
          status: 'done',
          cancelled: false,
          totals: { processed: 5, failed: 0, byOutcome: { review: 3 }, deleted: 2 },
        }}
        onCancel={vi.fn()}
        onDismiss={vi.fn()}
      />,
    );
    expect(screen.getByRole('status')).toHaveTextContent('5 emails processed. They ended as: 3 In review, 2 deleted.');
  });

  it('says nothing about deletions when there were none', () => {
    render(
      <ProcessStatus
        state={{ status: 'done', cancelled: false, totals: { processed: 1, failed: 0, byOutcome: { review: 1 }, deleted: 0 } }}
        onCancel={vi.fn()}
        onDismiss={vi.fn()}
      />,
    );
    expect(screen.getByRole('status')).not.toHaveTextContent('deleted');
  });
});
