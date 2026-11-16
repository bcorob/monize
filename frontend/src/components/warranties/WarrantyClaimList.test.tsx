import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, act, within } from '@/test/render';
import toast from 'react-hot-toast';
import type { WarrantyClaim } from '@/types/warranty';
import { WarrantyClaimList } from './WarrantyClaimList';

// The form is loaded through dynamic(); here it is the real form, loaded up front.
vi.mock('next/dynamic', async () => {
  const { WarrantyClaimForm } = await import('./WarrantyClaimForm');
  return { default: () => WarrantyClaimForm };
});

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() }),
}));

const mockListClaims = vi.fn();
const mockCreateClaim = vi.fn();
const mockUpdateClaim = vi.fn();
const mockDeleteClaim = vi.fn();
vi.mock('@/lib/warranties', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/warranties')>()),
  warrantiesApi: {
    listClaims: (...args: unknown[]) => mockListClaims(...args),
    createClaim: (...args: unknown[]) => mockCreateClaim(...args),
    updateClaim: (...args: unknown[]) => mockUpdateClaim(...args),
    deleteClaim: (...args: unknown[]) => mockDeleteClaim(...args),
  },
}));

function claim(overrides: Partial<WarrantyClaim> = {}): WarrantyClaim {
  return {
    id: 'c-1',
    warrantyId: 'w-1',
    claimDate: '2026-10-05',
    status: 'open',
    description: 'Screen flickers, see https://support.example.com/rma/42',
    resolution: null,
    resolvedOn: null,
    createdAt: '2026-10-05T00:00:00Z',
    updatedAt: '2026-10-05T00:00:00Z',
    ...overrides,
  };
}

async function renderList(onChanged = vi.fn()) {
  await act(async () => {
    render(<WarrantyClaimList warrantyId="w-1" today="2026-10-21" onChanged={onChanged} />);
  });
  return { onChanged };
}

describe('WarrantyClaimList', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockListClaims.mockResolvedValue([claim()]);
    mockCreateClaim.mockResolvedValue(claim({ id: 'c-2' }));
    mockUpdateClaim.mockResolvedValue(claim());
    mockDeleteClaim.mockResolvedValue(undefined);
  });

  it('lists the claims read-only, with no Add, Edit or Delete', async () => {
    await act(async () => {
      render(<WarrantyClaimList warrantyId="w-1" today="2026-10-21" readOnly />);
    });
    expect(screen.getByTestId('claim-c-1')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Add claim' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Edit' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Delete' })).not.toBeInTheDocument();
  });

  it('lists the claims against the warranty, with the address in a description as a link', async () => {
    await renderList();
    expect(mockListClaims).toHaveBeenCalledWith('w-1');
    const row = screen.getByTestId('claim-c-1');
    expect(within(row).getByText('Open')).toBeInTheDocument();
    expect(within(row).getByText('Claimed 10/05/2026')).toBeInTheDocument();
    expect(within(row).getByRole('link', { name: 'https://support.example.com/rma/42' })).toBeInTheDocument();
  });

  it('shows a closed claim with its closing date and resolution', async () => {
    mockListClaims.mockResolvedValue([
      claim({ status: 'resolved', resolvedOn: '2026-10-12', resolution: 'Replaced', description: null }),
    ]);
    await renderList();
    const row = screen.getByTestId('claim-c-1');
    expect(within(row).getByText('Resolved')).toBeInTheDocument();
    expect(within(row).getByText('Closed 10/12/2026')).toBeInTheDocument();
    expect(within(row).getByText('Resolution: Replaced')).toBeInTheDocument();
  });

  it('says there are no claims only when the list loaded empty', async () => {
    mockListClaims.mockResolvedValue([]);
    await renderList();
    expect(screen.getByText('No claims yet')).toBeInTheDocument();
  });

  it('says a failed list failed, never that there are none, and retries', async () => {
    mockListClaims.mockRejectedValueOnce(new Error('500'));
    await renderList();
    expect(screen.getByRole('alert')).toHaveTextContent('The claims could not be loaded.');
    expect(screen.queryByText('No claims yet')).not.toBeInTheDocument();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    });
    expect(mockListClaims).toHaveBeenCalledTimes(2);
    expect(screen.getByTestId('claim-c-1')).toBeInTheDocument();
  });

  it('adds a claim through the form and refreshes', async () => {
    const { onChanged } = await renderList();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Add claim' }));
    });
    const dialog = screen.getByRole('dialog', { name: 'New claim' });
    fireEvent.change(within(dialog).getByLabelText('Description'), { target: { value: 'Hinge cracked' } });
    await act(async () => {
      fireEvent.click(within(dialog).getByRole('button', { name: 'Add claim' }));
    });
    expect(mockCreateClaim).toHaveBeenCalledWith('w-1', {
      claimDate: '2026-10-21',
      status: 'open',
      description: 'Hinge cracked',
      resolution: null,
      resolvedOn: null,
    });
    expect(toast.success).toHaveBeenCalledWith('Claim added');
    expect(onChanged).toHaveBeenCalled();
    expect(mockListClaims).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole('dialog', { name: 'New claim' })).not.toBeInTheDocument();
  });

  it('keeps the form open with what was typed when the server refuses', async () => {
    mockCreateClaim.mockRejectedValue(new Error('400'));
    const { onChanged } = await renderList();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Add claim' }));
    });
    const dialog = screen.getByRole('dialog', { name: 'New claim' });
    await act(async () => {
      fireEvent.click(within(dialog).getByRole('button', { name: 'Add claim' }));
    });
    expect(toast.error).toHaveBeenCalled();
    expect(onChanged).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog', { name: 'New claim' })).toBeInTheDocument();
  });

  it('edits a claim', async () => {
    await renderList();
    await act(async () => {
      fireEvent.click(within(screen.getByTestId('claim-c-1')).getByRole('button', { name: 'Edit' }));
    });
    const dialog = screen.getByRole('dialog', { name: 'Edit claim' });
    fireEvent.change(within(dialog).getByLabelText('Status'), { target: { value: 'approved' } });
    await act(async () => {
      fireEvent.click(within(dialog).getByRole('button', { name: 'Save changes' }));
    });
    expect(mockUpdateClaim).toHaveBeenCalledWith('w-1', 'c-1', expect.objectContaining({ status: 'approved', resolvedOn: null }));
    expect(toast.success).toHaveBeenCalledWith('Claim updated');
  });

  it('deletes a claim after confirmation', async () => {
    const { onChanged } = await renderList();
    await act(async () => {
      fireEvent.click(within(screen.getByTestId('claim-c-1')).getByRole('button', { name: 'Delete' }));
    });
    const confirm = screen.getByRole('dialog');
    expect(confirm).toHaveTextContent('Delete claim');
    expect(confirm).toHaveTextContent('Delete the claim made on 10/05/2026?');
    await act(async () => {
      fireEvent.click(within(confirm).getByRole('button', { name: 'Delete' }));
    });
    expect(mockDeleteClaim).toHaveBeenCalledWith('w-1', 'c-1');
    expect(toast.success).toHaveBeenCalledWith('Claim deleted');
    expect(onChanged).toHaveBeenCalled();
  });
});
