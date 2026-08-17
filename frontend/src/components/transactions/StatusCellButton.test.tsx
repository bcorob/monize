import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@/test/render';
import { StatusCellButton } from './StatusCellButton';
import { TransactionStatus } from '@/types/transaction';

describe('StatusCellButton', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const denseCases: Array<[TransactionStatus, string]> = [
    [TransactionStatus.UNRECONCILED, '○'],
    [TransactionStatus.CLEARED, 'C'],
    [TransactionStatus.RECONCILED, 'R'],
    [TransactionStatus.VOID, 'V'],
  ];

  it.each(denseCases)(
    'renders the dense letter for %s when dense',
    (status, letter) => {
      render(<StatusCellButton status={status} dense onCycle={vi.fn()} />);
      expect(screen.getByText(letter)).toBeInTheDocument();
    },
  );

  const fullCases: Array<[TransactionStatus, string]> = [
    [TransactionStatus.UNRECONCILED, 'Pending'],
    [TransactionStatus.CLEARED, 'Cleared'],
    [TransactionStatus.RECONCILED, 'Reconciled'],
    // The full VOID label is upper-cased by the component.
    [TransactionStatus.VOID, 'VOID'],
  ];

  it.each(fullCases)(
    'renders the full label for %s when not dense',
    (status, label) => {
      render(
        <StatusCellButton status={status} dense={false} onCycle={vi.fn()} />,
      );
      expect(screen.getByText(label)).toBeInTheDocument();
    },
  );

  it('carries the cycle title so the click affordance is announced', () => {
    render(
      <StatusCellButton
        status={TransactionStatus.UNRECONCILED}
        dense={false}
        onCycle={vi.fn()}
      />,
    );
    expect(
      screen.getByTitle('Click to cycle status'),
    ).toBeInTheDocument();
  });

  it('calls onCycle when clicked', () => {
    const onCycle = vi.fn();
    render(
      <StatusCellButton
        status={TransactionStatus.UNRECONCILED}
        dense={false}
        onCycle={onCycle}
      />,
    );
    fireEvent.click(screen.getByRole('button'));
    expect(onCycle).toHaveBeenCalledTimes(1);
  });

  it('does not propagate the click to a parent handler (the row must not also fire)', () => {
    const onCycle = vi.fn();
    const parentClick = vi.fn();
    render(
      <div onClick={parentClick}>
        <StatusCellButton
          status={TransactionStatus.CLEARED}
          dense={false}
          onCycle={onCycle}
        />
      </div>,
    );
    fireEvent.click(screen.getByRole('button'));
    expect(onCycle).toHaveBeenCalledTimes(1);
    expect(parentClick).not.toHaveBeenCalled();
  });
});
