import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@/test/render';
import {
  MnyWipeConfirmDialog,
  WIPE_CONFIRM_WORD,
} from './MnyWipeConfirmDialog';

/**
 * PR #192's migration script deleted every account, transaction, budget, payee
 * and category with no prompt whatsoever. These tests pin the opposite: the
 * wipe cannot start without the typed keyword *and* the account password, and
 * the dialog says which operation it is about to run.
 */
describe('MnyWipeConfirmDialog', () => {
  const defaultProps = {
    isOpen: true,
    isOidc: false,
    isLoading: false,
    onConfirm: vi.fn(),
    onCancel: vi.fn(),
  };

  beforeEach(() => vi.clearAllMocks());

  function typeConfirmation(word: string) {
    fireEvent.change(screen.getByPlaceholderText(WIPE_CONFIRM_WORD), {
      target: { value: word },
    });
  }

  function typePassword(password: string) {
    fireEvent.change(screen.getByLabelText('Password'), {
      target: { value: password },
    });
  }

  it('names the operation it runs and what that removes', () => {
    render(<MnyWipeConfirmDialog {...defaultProps} />);

    expect(screen.getByRole('dialog', { name: 'Remove Existing Data' })).toBeInTheDocument();
    expect(screen.getByText(/Delete My Data operation/)).toBeInTheDocument();
    expect(screen.getByText('Every transaction and split')).toBeInTheDocument();
    expect(screen.getByText(/cannot be undone/)).toBeInTheDocument();
  });

  it('keeps the confirm button disabled until both the keyword and password are given', () => {
    render(<MnyWipeConfirmDialog {...defaultProps} />);
    const confirm = screen.getByRole('button', {
      name: 'Delete my data and import',
    });

    expect(confirm).toBeDisabled();

    typeConfirmation(WIPE_CONFIRM_WORD);
    expect(confirm).toBeDisabled();

    typePassword('hunter2');
    expect(confirm).toBeEnabled();
  });

  it('rejects a near-miss of the confirmation word', () => {
    render(<MnyWipeConfirmDialog {...defaultProps} />);

    typeConfirmation('delete');
    typePassword('hunter2');

    expect(
      screen.getByRole('button', { name: 'Delete my data and import' }),
    ).toBeDisabled();
  });

  it('passes the password up once both are given', () => {
    const onConfirm = vi.fn();
    render(<MnyWipeConfirmDialog {...defaultProps} onConfirm={onConfirm} />);

    typeConfirmation(WIPE_CONFIRM_WORD);
    typePassword('hunter2');
    fireEvent.click(
      screen.getByRole('button', { name: 'Delete my data and import' }),
    );

    expect(onConfirm).toHaveBeenCalledWith('hunter2');
  });

  it('asks an OIDC account for the keyword only', () => {
    const onConfirm = vi.fn();
    render(
      <MnyWipeConfirmDialog {...defaultProps} isOidc onConfirm={onConfirm} />,
    );

    expect(
      screen.queryByLabelText('Password'),
    ).not.toBeInTheDocument();

    typeConfirmation(WIPE_CONFIRM_WORD);
    fireEvent.click(
      screen.getByRole('button', { name: 'Delete my data and import' }),
    );

    expect(onConfirm).toHaveBeenCalledWith('');
  });

  it('cancels without confirming', () => {
    const onCancel = vi.fn();
    const onConfirm = vi.fn();
    render(
      <MnyWipeConfirmDialog
        {...defaultProps}
        onCancel={onCancel}
        onConfirm={onConfirm}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(onCancel).toHaveBeenCalled();
    expect(onConfirm).not.toHaveBeenCalled();
  });
});
