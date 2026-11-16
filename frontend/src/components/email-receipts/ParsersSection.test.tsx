import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AxiosError } from 'axios';
import toast from 'react-hot-toast';
import { render, screen, fireEvent, act, within } from '@/test/render';
import { ParsersSection } from './ParsersSection';
import { makeParser } from './email-receipts-fixtures';
import { TOUR_ANCHORS, tourAnchorSelector } from '@/lib/tours/anchors';

const api = vi.hoisted(() => ({
  list: vi.fn(),
  approve: vi.fn(),
  remove: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  test: vi.fn(),
  receiptsList: vi.fn(),
  listDomains: vi.fn(),
  listUncovered: vi.fn(),
  processBatch: vi.fn(),
  profileBatch: vi.fn(),
}));
const payeesApi = vi.hoisted(() => ({ getAll: vi.fn() }));
const categoriesApi = vi.hoisted(() => ({ getAll: vi.fn() }));
const accountsApi = vi.hoisted(() => ({ getAll: vi.fn() }));
const exchangeRatesApi = vi.hoisted(() => ({ getCurrencies: vi.fn() }));

vi.mock('@/lib/email-receipts-api', () => ({
  emailReceiptsApi: {
    parsers: { list: api.list, approve: api.approve, remove: api.remove, create: api.create, update: api.update, test: api.test },
    receipts: {
      list: api.receiptsList,
      listDomains: api.listDomains,
      listUncovered: api.listUncovered,
      processBatch: api.processBatch,
      profileBatch: api.profileBatch,
    },
  },
}));
vi.mock('@/lib/payees', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/payees')>()),
  payeesApi,
}));
vi.mock('@/lib/categories', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/categories')>()),
  categoriesApi,
}));
vi.mock('@/lib/accounts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/accounts')>()),
  accountsApi,
}));
vi.mock('@/lib/exchange-rates', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/exchange-rates')>()),
  exchangeRatesApi,
}));
vi.mock('@/components/email-receipts/ProfileWizard', () => ({
  ProfileWizard: ({ domain, onClose, onFinished }: { domain: string; onClose: () => void; onFinished: () => void }) => (
    <div data-testid="wizard">
      wizard for {domain}
      <button type="button" onClick={onFinished}>
        finish wizard
      </button>
      <button type="button" onClick={onClose}>
        close wizard
      </button>
    </div>
  ),
}));
vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() }),
}));

function conflict() {
  return new AxiosError('conflict', '409', undefined, undefined, { status: 409, data: { message: 'moved' } } as never);
}

async function renderSection(props: React.ComponentProps<typeof ParsersSection> = {}) {
  await act(async () => {
    render(<ParsersSection {...props} />);
  });
  await act(async () => {});
}

async function click(element: HTMLElement) {
  await act(async () => {
    fireEvent.click(element);
  });
  await act(async () => {});
}

const approved = makeParser();
const draft = makeParser({ id: 'p-2', name: 'Amazon draft', status: 'draft', source: 'ai', payeeId: null, fromDomains: ['amazon.com'], revision: 5 });

describe('ParsersSection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.list.mockResolvedValue([approved, draft]);
    api.receiptsList.mockResolvedValue([]);
    api.listDomains.mockResolvedValue([]);
    api.listUncovered.mockResolvedValue([]);
    payeesApi.getAll.mockResolvedValue([{ id: 'payee-1', name: 'Allegro' }]);
    categoriesApi.getAll.mockResolvedValue([]);
    accountsApi.getAll.mockResolvedValue([]);
    exchangeRatesApi.getCurrencies.mockResolvedValue([]);
  });

  it('marks a brokerage trade profile, and only that one', async () => {
    api.list.mockResolvedValue([
      approved,
      makeParser({ id: 'p-t', name: 'Broker trades', definition: { version: 2, trade: { action: ['{action}'] } } }),
    ]);
    await renderSection();
    expect(within(screen.getByRole('row', { name: /Broker trades/ })).getByText('Brokerage trades')).toBeInTheDocument();
    expect(within(screen.getByRole('row', { name: /Allegro parser/ })).queryByText('Brokerage trades')).not.toBeInTheDocument();
  });

  it('lists each profile with its domains, status, source and payee', async () => {
    await renderSection();
    const approvedRow = screen.getByRole('row', { name: /Allegro parser/ });
    expect(within(approvedRow).getByText('allegro.pl')).toBeInTheDocument();
    expect(within(approvedRow).getByText('Approved')).toBeInTheDocument();
    expect(within(approvedRow).getByText('Written by you')).toBeInTheDocument();
    expect(within(approvedRow).getByText('Allegro')).toBeInTheDocument();

    const draftRow = screen.getByRole('row', { name: /Amazon draft/ });
    expect(within(draftRow).getByText('Draft')).toBeInTheDocument();
    expect(within(draftRow).getByText('Drafted by AI')).toBeInTheDocument();
    expect(within(draftRow).getByText('No payee')).toBeInTheDocument();
  });

  it('flags a profile whose stored definition is not valid and does not offer to approve it', async () => {
    api.list.mockResolvedValue([makeParser({ status: 'draft', definitionValid: false })]);
    await renderSection();
    const row = screen.getByRole('row', { name: /Allegro parser/ });
    expect(within(row).getByText('Invalid')).toBeInTheDocument();
    expect(within(row).queryByRole('button', { name: 'Approve' })).not.toBeInTheDocument();
  });

  it('offers to approve a draft only', async () => {
    await renderSection();
    expect(within(screen.getByRole('row', { name: /Amazon draft/ })).getByRole('button', { name: 'Approve' })).toBeInTheDocument();
    expect(within(screen.getByRole('row', { name: /Allegro parser/ })).queryByRole('button', { name: 'Approve' })).not.toBeInTheDocument();
  });

  describe('view JSON', () => {
    it('offers View JSON on every profile, draft or approved, valid or not', async () => {
      api.list.mockResolvedValue([
        approved,
        draft,
        makeParser({ id: 'p-3', name: 'Broken', definitionValid: false, definition: {} }),
      ]);
      await renderSection();
      for (const name of [/Allegro parser/, /Amazon draft/, /Broken/]) {
        expect(within(screen.getByRole('row', { name })).getByRole('button', { name: 'View JSON' })).toBeInTheDocument();
      }
    });

    it('opens the stored definition read-only and copies it', async () => {
      const writeText = vi.fn().mockResolvedValue(undefined);
      Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
      const definition = { version: 2, total: [{ label: 'RAZEM', value: '{amount} zł' }] };
      api.list.mockResolvedValue([makeParser({ definition })]);
      await renderSection();
      await click(within(screen.getByRole('row', { name: /Allegro parser/ })).getByRole('button', { name: 'View JSON' }));

      const dialog = screen.getByRole('dialog', { name: 'Definition of Allegro parser' });
      expect(within(dialog).getByLabelText('Definition JSON').textContent).toBe(JSON.stringify(definition, null, 2));
      await click(within(dialog).getByRole('button', { name: 'Copy' }));
      expect(writeText).toHaveBeenCalledWith(JSON.stringify(definition, null, 2));
      expect(toast.success).toHaveBeenCalledWith('JSON copied');

      await act(async () => {
        fireEvent.keyDown(document, { key: 'Escape' });
      });
      expect(screen.queryByRole('dialog', { name: 'Definition of Allegro parser' })).not.toBeInTheDocument();
    });
  });

  describe('approve', () => {
    it('approves at the revision the person read and updates the row', async () => {
      api.approve.mockResolvedValue({ ...draft, status: 'approved', revision: 6 });
      await renderSection();
      await click(within(screen.getByRole('row', { name: /Amazon draft/ })).getByRole('button', { name: 'Approve' }));
      expect(api.approve).toHaveBeenCalledWith('p-2', 5);
      expect(toast.success).toHaveBeenCalledWith('Profile approved');
      const row = screen.getByRole('row', { name: /Amazon draft/ });
      expect(within(row).getByText('Approved')).toBeInTheDocument();
      expect(within(row).queryByRole('button', { name: 'Approve' })).not.toBeInTheDocument();
    });

    it('says the profile changed elsewhere on a 409 and reloads the list', async () => {
      api.approve.mockRejectedValue(conflict());
      await renderSection();
      expect(api.list).toHaveBeenCalledTimes(1);
      await click(within(screen.getByRole('row', { name: /Amazon draft/ })).getByRole('button', { name: 'Approve' }));
      expect(toast.error).toHaveBeenCalledWith('This profile was changed elsewhere. The list has been reloaded.');
      expect(api.list).toHaveBeenCalledTimes(2);
    });

    it('names any other failure', async () => {
      api.approve.mockRejectedValue({ response: { data: { message: 'Not valid' } } });
      await renderSection();
      await click(within(screen.getByRole('row', { name: /Amazon draft/ })).getByRole('button', { name: 'Approve' }));
      expect(toast.error).toHaveBeenCalledWith('Not valid');
    });
  });

  describe('processing the stored emails after an approval', () => {
    const approveDraft = async () => {
      api.approve.mockResolvedValue({ ...draft, status: 'approved', revision: 6 });
      await renderSection();
      await click(within(screen.getByRole('row', { name: /Amazon draft/ })).getByRole('button', { name: /Approve/ }));
    };

    it('asks to process the stored emails of the profile\'s senders when some are waiting', async () => {
      api.listDomains.mockResolvedValue([
        { domain: 'amazon.com', count: 9, processable: 4 },
        { domain: 'mail.amazon.com', count: 3, processable: 3 },
        { domain: 'other.example', count: 5, processable: 5 },
      ]);
      await approveDraft();
      const dialog = screen.getByRole('dialog');
      expect(dialog).toHaveTextContent('Process the 7 stored emails from amazon.com now?');
    });

    it('runs the bulk call for each sender domain when confirmed, and says where the emails ended', async () => {
      api.listDomains.mockResolvedValue([{ domain: 'amazon.com', count: 2, processable: 2 }]);
      api.processBatch.mockResolvedValue({
        processed: 2,
        byOutcome: { review: 2 },
        failed: 0,
        remaining: 0,
        since: '2026-10-04T10:00:00.000000Z',
      });
      await approveDraft();
      await click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Process now' }));
      expect(api.processBatch).toHaveBeenCalledWith({ domain: 'amazon.com' });
      expect(screen.getByRole('status')).toHaveTextContent('2 emails processed.');
    });

    it('does nothing when the person says not now', async () => {
      api.listDomains.mockResolvedValue([{ domain: 'amazon.com', count: 2, processable: 2 }]);
      await approveDraft();
      await click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Not now' }));
      expect(api.processBatch).not.toHaveBeenCalled();
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });

    it('does not ask when no stored email of those senders can be processed', async () => {
      api.listDomains.mockResolvedValue([{ domain: 'amazon.com', count: 2, processable: 0 }]);
      await approveDraft();
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });

    it('does not ask, and does not fail, when the counts could not be read', async () => {
      api.listDomains.mockRejectedValue(new Error('down'));
      await approveDraft();
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      expect(toast.success).toHaveBeenCalledWith('Profile approved');
    });
  });

  describe('delete', () => {
    it('asks first, and deletes nothing when cancelled', async () => {
      await renderSection();
      await click(within(screen.getByRole('row', { name: /Allegro parser/ })).getByRole('button', { name: 'Delete' }));
      const dialog = screen.getByRole('dialog');
      expect(within(dialog).getByText(/The profile Allegro parser will be deleted/)).toBeInTheDocument();
      await click(within(dialog).getByRole('button', { name: 'Cancel' }));
      expect(api.remove).not.toHaveBeenCalled();
      expect(screen.getByRole('row', { name: /Allegro parser/ })).toBeInTheDocument();
    });

    it('deletes on confirmation and removes the row', async () => {
      api.remove.mockResolvedValue(undefined);
      await renderSection();
      await click(within(screen.getByRole('row', { name: /Allegro parser/ })).getByRole('button', { name: 'Delete' }));
      await click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Delete' }));
      expect(api.remove).toHaveBeenCalledWith('p-1');
      expect(toast.success).toHaveBeenCalledWith('Profile deleted');
      expect(screen.queryByRole('row', { name: /Allegro parser/ })).not.toBeInTheDocument();
    });

    it('keeps the row and names the failure', async () => {
      api.remove.mockRejectedValue({ response: { data: { message: 'Cannot delete' } } });
      await renderSection();
      await click(within(screen.getByRole('row', { name: /Allegro parser/ })).getByRole('button', { name: 'Delete' }));
      await click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Delete' }));
      expect(toast.error).toHaveBeenCalledWith('Cannot delete');
      expect(screen.getByRole('row', { name: /Allegro parser/ })).toBeInTheDocument();
    });
  });

  describe('the emphasis', () => {
    it('shows the manual button as the quiet outline variant, and the domain section as the highlighted one', async () => {
      await renderSection();
      const button = screen.getByRole('button', { name: 'Create a new profile manually' });
      expect(button.className).toContain('border-gray-300');
      expect(button.className).not.toContain('bg-blue-600');
      const heading = screen.getByRole('heading', { name: 'Create a profile for a domain' });
      expect(heading.closest('section')?.className).toContain('border-blue-500');
    });
  });

  describe('the editor', () => {
    it('opens empty for a new profile and reloads the list after a save', async () => {
      api.create.mockResolvedValue(makeParser({ id: 'p-3' }));
      await renderSection();
      await click(screen.getByRole('button', { name: 'Create a new profile manually' }));
      expect(screen.getByRole('dialog', { name: 'New profile' })).toBeInTheDocument();
      await act(async () => {
        fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Shop' } });
        fireEvent.change(screen.getByLabelText('Sender domains'), { target: { value: 'shop.example' } });
      });
      await click(screen.getByRole('button', { name: 'Save profile' }));
      expect(api.create).toHaveBeenCalledTimes(1);
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      expect(api.list).toHaveBeenCalledTimes(2);
    });

    it('opens a stored profile for editing', async () => {
      await renderSection();
      await click(within(screen.getByRole('row', { name: /Allegro parser/ })).getByRole('button', { name: 'Edit' }));
      expect(screen.getByRole('dialog', { name: 'Edit profile' })).toBeInTheDocument();
      expect((screen.getByLabelText('Name') as HTMLInputElement).value).toBe('Allegro parser');
    });

    it('closes the editor and reloads the list when the profile moved on under it', async () => {
      api.update.mockRejectedValue(conflict());
      await renderSection();
      await click(within(screen.getByRole('row', { name: /Allegro parser/ })).getByRole('button', { name: 'Edit' }));
      await act(async () => {
        fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Renamed' } });
      });
      await click(screen.getByRole('button', { name: 'Save profile' }));
      await click(screen.getByRole('button', { name: 'Reload the profile' }));
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      expect(api.list).toHaveBeenCalledTimes(2);
    });
  });

  it('says a payee is not found only when the payee list loaded without it', async () => {
    payeesApi.getAll.mockResolvedValue([]);
    await renderSection();
    expect(within(screen.getByRole('row', { name: /Allegro parser/ })).getByText('Payee not found')).toBeInTheDocument();
  });

  it('says there are no profiles only when the list loaded empty', async () => {
    api.list.mockResolvedValue([]);
    await renderSection();
    expect(screen.getByText('No profiles yet')).toBeInTheDocument();
  });

  it('anchors the email receipts tour on the list only once it holds a profile', async () => {
    const anchor = () => document.querySelector(tourAnchorSelector(TOUR_ANCHORS.emailReceiptsProfiles));
    await renderSection();
    expect(anchor()).toBeInTheDocument();
    expect(anchor()).toContainElement(screen.getByRole('row', { name: /Allegro parser/ }));
  });

  it('does not anchor the tour on an empty list', async () => {
    const anchor = () => document.querySelector(tourAnchorSelector(TOUR_ANCHORS.emailReceiptsProfiles));
    api.list.mockResolvedValue([]);
    await renderSection();
    expect(anchor()).not.toBeInTheDocument();
  });

  it('does not anchor the tour on a list that failed to load', async () => {
    api.list.mockRejectedValue(new Error('boom'));
    await renderSection();
    expect(document.querySelector(tourAnchorSelector(TOUR_ANCHORS.emailReceiptsProfiles))).not.toBeInTheDocument();
  });

  it('shows a failed load as an error with a retry, never as an empty list', async () => {
    api.list.mockRejectedValueOnce(new Error('boom'));
    await renderSection();
    expect(screen.getByRole('alert')).toHaveTextContent('The profiles could not be loaded');
    expect(screen.queryByText('No profiles yet')).not.toBeInTheDocument();
    await click(screen.getByRole('button', { name: 'Try again' }));
    expect(screen.getByRole('row', { name: /Allegro parser/ })).toBeInTheDocument();
  });

  it('says the payee list is unavailable when it could not be loaded, not that the payee is gone', async () => {
    payeesApi.getAll.mockRejectedValue(new Error('boom'));
    await renderSection();
    const row = screen.getByRole('row', { name: /Allegro parser/ });
    expect(within(row).queryByText('No payee')).not.toBeInTheDocument();
    // A payee list that failed to load is not a payee that does not exist.
    expect(within(row).queryByText('Payee not found')).not.toBeInTheDocument();
    expect(within(row).getByText('Payee list unavailable')).toBeInTheDocument();
  });
  describe('Re-parse emails', () => {
    it('is offered on an approved profile with emails to re-parse, and not otherwise', async () => {
      api.list.mockResolvedValue([
        makeParser({ reprocessableCount: 3 }),
        makeParser({ id: 'p-3', name: 'Zero parser', reprocessableCount: 0 }),
        makeParser({ id: 'p-4', name: 'Absent parser' }),
        makeParser({ id: 'p-5', name: 'Draft parser', status: 'draft', reprocessableCount: 2 }),
      ]);
      await renderSection();
      expect(screen.getAllByRole('button', { name: /Re-parse emails/ })).toHaveLength(1);
      expect(within(screen.getByRole('row', { name: /Allegro parser/ })).getByRole('button', { name: 'Re-parse emails (3)' })).toBeInTheDocument();
    });

    it('processes the profile\'s domains and reads the profiles again', async () => {
      api.list.mockResolvedValue([makeParser({ reprocessableCount: 3 })]);
      api.processBatch.mockResolvedValue({ processed: 3, byOutcome: { review: 3 }, failed: 0, remaining: 0, since: 'T' });
      await renderSection();
      await click(screen.getByRole('button', { name: 'Re-parse emails (3)' }));
      expect(api.processBatch).toHaveBeenCalledWith({ domain: 'allegro.pl' });
      expect(api.list).toHaveBeenCalledTimes(2);
    });
  });

  describe('Create a profile for a domain', () => {
    it('lists the uncovered domains and starts the wizard for the one clicked', async () => {
      api.listUncovered.mockResolvedValue([
        { domain: 'shop.example.com', count: 4, draftParserId: null },
        { domain: 'x.example', count: 1, draftParserId: 'p-9' },
      ]);
      const onWizardDomainChange = vi.fn();
      await renderSection({ onWizardDomainChange });
      expect(screen.getByRole('heading', { name: 'Create a profile for a domain' })).toBeInTheDocument();
      await click(screen.getByRole('button', { name: 'shop.example.com (4)' }));
      expect(onWizardDomainChange).toHaveBeenCalledWith('shop.example.com');
    });

    it('says so when every domain is covered', async () => {
      await renderSection();
      expect(screen.getByText('Every sender of the stored emails is covered by a profile.')).toBeInTheDocument();
    });

    it('does not show a failed read as an empty cloud', async () => {
      api.listUncovered.mockRejectedValue(new Error('down'));
      await renderSection();
      expect(screen.getByText('The sender domains could not be loaded.')).toBeInTheDocument();
      expect(screen.queryByText('Every sender of the stored emails is covered by a profile.')).not.toBeInTheDocument();
    });

    it('shows the wizard in place of the cloud while a domain is open, and reads both lists again when it finishes', async () => {
      const onWizardDomainChange = vi.fn();
      await renderSection({ wizardDomain: 'shop.example.com', onWizardDomainChange });
      expect(screen.getByTestId('wizard')).toHaveTextContent('wizard for shop.example.com');
      expect(screen.queryByRole('heading', { name: 'Create a profile for a domain' })).not.toBeInTheDocument();
      await click(screen.getByRole('button', { name: 'finish wizard' }));
      expect(api.list).toHaveBeenCalledTimes(2);
      await click(screen.getByRole('button', { name: 'close wizard' }));
      expect(onWizardDomainChange).toHaveBeenCalledWith(null);
    });
  });

  describe("a profile that discards its emails", () => {
    const page = (over: Record<string, unknown> = {}) => ({
      matched: 0,
      applied: 0,
      unreadable: 0,
      ignored: 0,
      done: 0,
      next: null,
      ...over,
    });
    const ignoring = makeParser({
      id: 'p-9',
      name: 'Newsletters',
      definition: { version: 2, discard: 'ignore' },
    });
    const deleting = makeParser({
      id: 'p-8',
      name: 'Spam shop',
      definition: { version: 2, discard: 'delete' },
    });

    it('marks the profile on its row, and offers no bulk action in the menu', async () => {
      api.list.mockResolvedValue([ignoring, deleting]);
      await renderSection();
      expect(within(screen.getByRole('row', { name: /Newsletters/ })).getByText('Ignores its emails')).toBeInTheDocument();
      expect(within(screen.getByRole('row', { name: /Spam shop/ })).getByText('Deletes its emails')).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'More actions' })).not.toBeInTheDocument();
    });

    it('after a save, counts the stored emails it matches and offers to ignore them, every page', async () => {
      api.list.mockResolvedValue([ignoring]);
      api.update.mockResolvedValue(ignoring);
      api.profileBatch
        .mockResolvedValueOnce(page({ matched: 3, applied: 1, next: 'c-1' }))
        .mockResolvedValueOnce(page({ matched: 2, ignored: 1 }))
        .mockResolvedValueOnce(page({ matched: 3, done: 2, next: 'c-1' }))
        .mockResolvedValueOnce(page({ matched: 2, done: 1 }));
      await renderSection();
      await click(within(screen.getByRole('row', { name: /Newsletters/ })).getByRole('button', { name: 'Edit' }));
      await click(screen.getByRole('button', { name: 'Save profile' }));
      const dialog = screen.getByRole('dialog');
      expect(dialog).toHaveTextContent("Ignore this profile's emails?");
      expect(dialog).toHaveTextContent(
        '3 emails that Newsletters reads will be ignored: they propose nothing, and their open proposals are closed. 1 email that was already applied or could not be read stays as it is.',
      );
      expect(api.profileBatch).toHaveBeenNthCalledWith(2, { parserId: 'p-9', action: 'count', after: 'c-1' });

      await click(within(dialog).getByRole('button', { name: 'Ignore emails' }));
      expect(api.profileBatch).toHaveBeenNthCalledWith(3, { parserId: 'p-9', action: 'ignore' });
      expect(api.profileBatch).toHaveBeenNthCalledWith(4, { parserId: 'p-9', action: 'ignore', after: 'c-1' });
      expect(toast.success).toHaveBeenCalledWith('3 emails ignored');
    });

    it('deletes nothing when the person says not now', async () => {
      api.list.mockResolvedValue([deleting]);
      api.update.mockResolvedValue(deleting);
      api.profileBatch.mockResolvedValueOnce(page({ matched: 2 }));
      await renderSection();
      await click(within(screen.getByRole('row', { name: /Spam shop/ })).getByRole('button', { name: 'Edit' }));
      await click(screen.getByRole('button', { name: 'Save profile' }));
      const dialog = screen.getByRole('dialog');
      expect(dialog).toHaveTextContent("Delete this profile's emails?");
      expect(dialog).toHaveTextContent('2 emails that Spam shop reads will be deleted, with their open proposals. This cannot be undone.');
      await click(within(dialog).getByRole('button', { name: 'Not now' }));
      expect(api.profileBatch).toHaveBeenCalledTimes(1);
    });

    it('asks nothing when no stored email is left to act on, or the count fails', async () => {
      api.list.mockResolvedValue([deleting]);
      api.update.mockResolvedValue(deleting);
      api.profileBatch.mockResolvedValueOnce(page({ matched: 1, applied: 1 })).mockRejectedValueOnce(new Error('boom'));
      await renderSection();
      for (let i = 0; i < 2; i++) {
        await click(within(screen.getByRole('row', { name: /Spam shop/ })).getByRole('button', { name: 'Edit' }));
        await click(screen.getByRole('button', { name: 'Save profile' }));
        expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      }
    });

    it('offers nothing for a profile that reads its emails, or a draft', async () => {
      api.update.mockResolvedValue(approved);
      await renderSection();
      await click(within(screen.getByRole('row', { name: /Allegro parser/ })).getByRole('button', { name: 'Edit' }));
      await click(screen.getByRole('button', { name: 'Save profile' }));
      expect(api.profileBatch).not.toHaveBeenCalled();
    });
  });
});
