import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, act, waitFor } from '@/test/render';
import { DelegateAccessModal } from './DelegateAccessModal';
import type { DelegateSummary } from '@/lib/delegation';
import type { Account } from '@/types/account';

vi.mock('@/lib/delegation', () => ({
  delegationApi: {
    setGrants: vi.fn(),
    setCapabilities: vi.fn(),
    setSectionGrants: vi.fn(),
  },
}));

vi.mock('react-hot-toast', () => ({
  default: { success: vi.fn(), error: vi.fn() },
}));

import { delegationApi } from '@/lib/delegation';

const baseDelegate: DelegateSummary = {
  id: 'g1',
  status: 'active',
  createdAt: '2026-01-01',
  delegate: {
    id: 'd1',
    email: 'd@e.f',
    firstName: null,
    lastName: null,
    hasPassword: true,
    canResetPassword: true,
    isFullAccount: true,
  },
  grants: [],
  capabilities: {
    payees: { create: false, edit: false, delete: false },
    categories: { create: false, edit: false, delete: false },
    tags: { create: false, edit: false, delete: false },
  },
};

const accounts = [
  { id: 'a1', name: 'Chequing', accountType: 'CHEQUING' },
] as unknown as Account[];

// What GET /accounts actually returns in own context: the caller's own
// accounts plus accounts jointly shared *to* them by another owner.
const accountsWithJoint = [
  ...accounts,
  {
    id: 'j1',
    name: 'Partner Savings',
    accountType: 'SAVINGS',
    isJoint: true,
    ownerLabel: 'Partner',
  },
] as unknown as Account[];

function renderModal(
  delegate: DelegateSummary = baseDelegate,
  accountList: Account[] = accounts,
) {
  const submitRef = { current: null as (() => void) | null };
  const setFormDirty = vi.fn();
  const onSaved = vi.fn();
  const onCancel = vi.fn();
  render(
    <DelegateAccessModal
      delegate={delegate}
      accounts={accountList}
      onCancel={onCancel}
      onSaved={onSaved}
      setFormDirty={setFormDirty}
      submitRef={submitRef}
    />,
  );
  return { submitRef, setFormDirty, onSaved, onCancel };
}

describe('DelegateAccessModal', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(delegationApi.setGrants).mockResolvedValue();
    vi.mocked(delegationApi.setCapabilities).mockResolvedValue();
    vi.mocked(delegationApi.setSectionGrants).mockResolvedValue();
  });

  it('lists grantable accounts grouped by type', () => {
    renderModal();
    expect(screen.getAllByText('Chequing').length).toBeGreaterThan(0);
    expect(
      screen.getByRole('switch', { name: /Read access to Chequing/i }),
    ).toBeInTheDocument();
  });

  it('hides accounts delegated to the caller, joint ones included', () => {
    renderModal(baseDelegate, accountsWithJoint);
    // Own account is still offered...
    expect(
      screen.getByRole('switch', { name: /Read access to Chequing/i }),
    ).toBeInTheDocument();
    // ...but an account another owner shared with the caller is not, in any
    // form: no row, no group header, no per-column "grant all" for its type.
    expect(screen.queryByText('Partner Savings')).not.toBeInTheDocument();
    expect(
      screen.queryByRole('switch', { name: /access to Partner Savings/i }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('switch', { name: /all Savings accounts/i }),
    ).not.toBeInTheDocument();
  });

  it('shows the empty state when every visible account is delegated to the caller', () => {
    renderModal(baseDelegate, accountsWithJoint.filter((a) => a.isJoint));
    expect(
      screen.getByText('No accounts to grant.'),
    ).toBeInTheDocument();
  });

  it('never sends a delegated account in the grant payload', async () => {
    // A grant on j1 cannot exist server-side, but the save is
    // delete-and-recreate over the account list: were a delegated account to
    // reach the list it would be re-shared onward on the next unrelated save.
    renderModal(
      {
        ...baseDelegate,
        grants: [
          { accountId: 'a1', canRead: true },
          { accountId: 'j1', canRead: true, isJoint: true },
        ],
      },
      accountsWithJoint,
    );

    await act(async () => {
      fireEvent.click(
        screen.getByRole('switch', { name: /Create access to Chequing/i }),
      );
    });
    await act(async () => {
      fireEvent.click(screen.getByText('Save'));
    });

    await waitFor(() =>
      expect(delegationApi.setGrants).toHaveBeenCalledWith('g1', [
        expect.objectContaining({ accountId: 'a1', canRead: true }),
      ]),
    );
  });

  it('Save is disabled until something changes', () => {
    const { setFormDirty } = renderModal();
    expect(screen.getByText('Save')).toBeDisabled();
    expect(setFormDirty).toHaveBeenLastCalledWith(false);
  });

  it('batches a per-account READ grant on Save', async () => {
    renderModal();

    await act(async () => {
      fireEvent.click(
        screen.getByRole('switch', { name: /Read access to Chequing/i }),
      );
    });
    await act(async () => {
      fireEvent.click(screen.getByText('Save'));
    });

    await waitFor(() =>
      expect(delegationApi.setGrants).toHaveBeenCalledWith('g1', [
        {
          accountId: 'a1',
          canRead: true,
          canCreate: false,
          canEdit: false,
          canDelete: false,
          isJoint: false,
        },
      ]),
    );
    expect(delegationApi.setCapabilities).not.toHaveBeenCalled();
    expect(delegationApi.setSectionGrants).not.toHaveBeenCalled();
  });

  it('enabling CREATE implies READ', async () => {
    renderModal({
      ...baseDelegate,
      grants: [{ accountId: 'a1', canRead: true }],
    });

    await act(async () => {
      fireEvent.click(
        screen.getByRole('switch', { name: /Create access to Chequing/i }),
      );
    });
    await act(async () => {
      fireEvent.click(screen.getByText('Save'));
    });

    await waitFor(() =>
      expect(delegationApi.setGrants).toHaveBeenCalledWith('g1', [
        expect.objectContaining({
          accountId: 'a1',
          canRead: true,
          canCreate: true,
        }),
      ]),
    );
  });

  it('round-trips isJoint on an unchanged-looking save (regression: delete-and-recreate)', async () => {
    renderModal({
      ...baseDelegate,
      grants: [{ accountId: 'a1', canRead: true, isJoint: true }],
    });

    // Change something unrelated so a save fires, then assert the joint
    // flag survived the round trip -- the server recreates every grant row
    // from this payload, so dropping it here would clear the joint share.
    await act(async () => {
      fireEvent.click(
        screen.getByRole('switch', { name: /Create access to Chequing/i }),
      );
    });
    await act(async () => {
      fireEvent.click(screen.getByText('Save'));
    });

    await waitFor(() =>
      expect(delegationApi.setGrants).toHaveBeenCalledWith('g1', [
        expect.objectContaining({ accountId: 'a1', isJoint: true }),
      ]),
    );
  });

  it('offers Joint only once READ is on, then saves both flags', async () => {
    renderModal();
    // Like the write ops, Joint is disabled until READ is granted.
    expect(
      screen.getByRole('switch', { name: /Joint access to Chequing/i }),
    ).toBeDisabled();

    await act(async () => {
      fireEvent.click(
        screen.getByRole('switch', { name: /Read access to Chequing/i }),
      );
    });
    await act(async () => {
      fireEvent.click(
        screen.getByRole('switch', { name: /Joint access to Chequing/i }),
      );
    });
    await act(async () => {
      fireEvent.click(screen.getByText('Save'));
    });
    await waitFor(() =>
      expect(delegationApi.setGrants).toHaveBeenCalledWith('g1', [
        expect.objectContaining({
          accountId: 'a1',
          canRead: true,
          isJoint: true,
        }),
      ]),
    );
  });

  it('turning READ off clears the joint flag with it', async () => {
    renderModal({
      ...baseDelegate,
      grants: [{ accountId: 'a1', canRead: true, isJoint: true }],
    });
    await act(async () => {
      fireEvent.click(
        screen.getByRole('switch', { name: /Read access to Chequing/i }),
      );
    });
    // Grant dropped entirely (no canRead), so the saved array is empty.
    await act(async () => {
      fireEvent.click(screen.getByText('Save'));
    });
    await waitFor(() =>
      expect(delegationApi.setGrants).toHaveBeenCalledWith('g1', []),
    );
  });

  it('disables the Joint toggle for a delegate without a full account', () => {
    renderModal({
      ...baseDelegate,
      delegate: { ...baseDelegate.delegate, isFullAccount: false },
      // READ granted, so only the full-account rule can be what disables it.
      grants: [{ accountId: 'a1', canRead: true }],
    });
    expect(
      screen.getByRole('switch', { name: /Joint access to Chequing/i }),
    ).toBeDisabled();
    expect(
      screen.getByRole('switch', { name: /Create access to Chequing/i }),
    ).not.toBeDisabled();
  });

  it('batches a granular capability change (Edit Payees)', async () => {
    renderModal();

    fireEvent.click(screen.getByRole('tab', { name: 'Shared data' }));
    await act(async () => {
      fireEvent.click(screen.getByRole('switch', { name: /^Edit Payees$/i }));
    });
    await act(async () => {
      fireEvent.click(screen.getByText('Save'));
    });

    await waitFor(() =>
      expect(delegationApi.setCapabilities).toHaveBeenCalledWith('g1', {
        payeesCanEdit: true,
      }),
    );
    expect(delegationApi.setGrants).not.toHaveBeenCalled();
  });

  it('batches Delete Tags independently', async () => {
    renderModal();

    fireEvent.click(screen.getByRole('tab', { name: 'Shared data' }));
    await act(async () => {
      fireEvent.click(screen.getByRole('switch', { name: /^Delete Tags$/i }));
    });
    await act(async () => {
      fireEvent.click(screen.getByText('Save'));
    });

    await waitFor(() =>
      expect(delegationApi.setCapabilities).toHaveBeenCalledWith('g1', {
        tagsCanDelete: true,
      }),
    );
  });

  it('batches a section grant on Save', async () => {
    const { onSaved } = renderModal();

    fireEvent.click(screen.getByRole('tab', { name: 'Sections' }));
    await act(async () => {
      fireEvent.click(
        screen.getByRole('switch', { name: /Bills & Deposits section/i }),
      );
    });
    await act(async () => {
      fireEvent.click(screen.getByText('Save'));
    });

    await waitFor(() =>
      expect(delegationApi.setSectionGrants).toHaveBeenCalledWith('g1', {
        billsCanRead: true,
      }),
    );
    expect(onSaved).toHaveBeenCalled();
  });

  it('shows the Warranties section and saves its grant', async () => {
    renderModal();

    fireEvent.click(screen.getByRole('tab', { name: 'Sections' }));
    expect(
      screen.getByText(/their documents and claims/i),
    ).toBeInTheDocument();
    const toggle = screen.getByRole('switch', { name: /Warranties section/i });
    expect(toggle).toHaveAttribute('aria-checked', 'false');
    await act(async () => {
      fireEvent.click(toggle);
    });
    await act(async () => {
      fireEvent.click(screen.getByText('Save'));
    });

    await waitFor(() =>
      expect(delegationApi.setSectionGrants).toHaveBeenCalledWith('g1', {
        warrantiesCanRead: true,
      }),
    );
  });

  it('starts the Warranties toggle from the stored grant', async () => {
    renderModal({
      ...baseDelegate,
      sections: {
        bills: false,
        investments: false,
        budgets: false,
        reports: false,
        ai: false,
        warranties: true,
      },
    });

    fireEvent.click(screen.getByRole('tab', { name: 'Sections' }));
    const toggle = screen.getByRole('switch', { name: /Warranties section/i });
    expect(toggle).toHaveAttribute('aria-checked', 'true');
    await act(async () => {
      fireEvent.click(toggle);
    });
    await act(async () => {
      fireEvent.click(screen.getByText('Save'));
    });

    await waitFor(() =>
      expect(delegationApi.setSectionGrants).toHaveBeenCalledWith('g1', {
        warrantiesCanRead: false,
      }),
    );
  });

  it('says the AI Assistant needs every account and section', () => {
    renderModal();

    fireEvent.click(screen.getByRole('tab', { name: 'Sections' }));

    expect(
      screen.getByText(/only answers for this delegate once they can read all of your accounts/i),
    ).toBeInTheDocument();
  });

  it('marks the form dirty when a toggle changes', async () => {
    const { setFormDirty } = renderModal();
    await act(async () => {
      fireEvent.click(
        screen.getByRole('switch', { name: /Read access to Chequing/i }),
      );
    });
    expect(setFormDirty).toHaveBeenLastCalledWith(true);
  });
});
