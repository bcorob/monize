import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, cleanup, screen, waitFor, within } from '@testing-library/react';
import { render } from '@/test/render';
import { useAuthStore } from '@/store/authStore';
import SharePage from './page';
import type { SharedBundle, SharedBundleItem } from '@/lib/share-inbox';
import { classifySharedFile } from '@/lib/share-target';
import type { User } from '@/types/auth';

// The review screen is where the plan's second requirement lives: a share
// always lands somewhere that explains itself, and nothing is imported or
// attached without the user pressing a button. Every state below is one a user
// can reach, so each gets a case -- including the three that carry no bundle
// at all, which is what keeps a share off a browser error page.

// Not spread from the original: `next/navigation`'s real `useRouter` throws
// outside an app-router tree, so this replaces the module the way setup.ts does
// and adds the search params this screen reads.
const searchParams = { value: new URLSearchParams() };
const routerMock = vi.hoisted(() => ({
  push: vi.fn(),
  replace: vi.fn(),
  back: vi.fn(),
  prefetch: vi.fn(),
  refresh: vi.fn(),
}));
vi.mock('next/navigation', () => ({
  useRouter: () => routerMock,
  usePathname: () => '/share',
  useSearchParams: () => searchParams.value,
}));

const mocks = vi.hoisted(() => ({
  readSharedBundle: vi.fn(),
  listSharedBundles: vi.fn(),
  discardSharedBundle: vi.fn(),
  isShareInboxSupported: vi.fn(() => true),
}));

vi.mock('@/lib/share-inbox', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/share-inbox')>()),
  readSharedBundle: mocks.readSharedBundle,
  listSharedBundles: mocks.listSharedBundles,
  discardSharedBundle: mocks.discardSharedBundle,
  isShareInboxSupported: mocks.isShareInboxSupported,
}));

vi.mock('@/components/auth/ProtectedRoute', () => ({
  ProtectedRoute: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

// Whether an AI provider can answer at all. The real hook reads the cached
// status endpoint; the screen only ever asks it the one question.
const aiConfigured = vi.hoisted(() => ({ value: false }));
vi.mock('@/hooks/useAiConfigured', () => ({
  useAiConfigured: () => ({ configured: aiConfigured.value, resolved: true }),
}));

// The form is a heavy dynamic import with its own data loading; this screen's
// contract is only that it opens with the shared files staged.
const transactionForm = vi.hoisted(() => vi.fn());
vi.mock('@/components/transactions/TransactionForm', () => ({
  TransactionForm: (props: { initialStagedFiles?: File[] }) => {
    transactionForm(props);
    return <div data-testid="transaction-form" />;
  },
}));

/**
 * One stored entry as the WORKER writes it: `kind` is the classification it
 * recorded on arrival, not null. A fixture that left it null would be a shape
 * the worker never produces (it refuses an unclassifiable file rather than
 * storing one), and the screen reads that field.
 */
function item(
  name: string,
  type: string,
  overrides: Partial<SharedBundleItem> = {},
): SharedBundleItem {
  const hasFile = overrides.file !== null;
  return {
    entry: {
      name,
      type,
      size: 10,
      kind: classifySharedFile({ name, type }),
      key: 'k',
    },
    file: hasFile ? new File(['x'], name, { type }) : null,
    missing: false,
    ...overrides,
  };
}

function bundle(items: SharedBundleItem[], overrides: Partial<SharedBundle> = {}): SharedBundle {
  return {
    index: {
      id: 'bundle-1',
      createdAt: Date.now(),
      files: items.map((entryItem) => entryItem.entry),
    },
    items,
    files: items
      .map((entryItem) => entryItem.file)
      .filter((file): file is File => file !== null),
    expired: false,
    ...overrides,
  };
}

/**
 * The reader every case is written for. A bundle belongs to the first
 * authenticated reader that observes it, so the screen reads nothing at all
 * until the auth store names one -- which makes the signed-in user a
 * prerequisite of this page's fixtures, not decoration.
 */
const VIEWER_ID = 'user-1';

function signIn(id: string | null) {
  useAuthStore.setState({
    user: id ? ({ id, email: 'reader@monize.test' } as User) : null,
    isAuthenticated: id !== null,
  });
}

async function renderPage() {
  await act(async () => {
    render(<SharePage />);
  });
}

describe('share review screen', () => {
  beforeEach(() => {
    signIn(VIEWER_ID);
    searchParams.value = new URLSearchParams('id=bundle-1');
    mocks.isShareInboxSupported.mockReturnValue(true);
    mocks.listSharedBundles.mockResolvedValue([]);
    mocks.discardSharedBundle.mockResolvedValue(undefined);
    mocks.readSharedBundle.mockResolvedValue(null);
    aiConfigured.value = false;
    transactionForm.mockClear();
  });

  afterEach(() => {
    cleanup();
    signIn(null);
    vi.clearAllMocks();
  });

  it('offers a new transaction for a share of receipts, and stages the files', async () => {
    const items = [item('receipt.jpg', 'image/jpeg'), item('bill.pdf', 'application/pdf')];
    mocks.readSharedBundle.mockResolvedValue(bundle(items));

    await renderPage();

    expect(await screen.findByText('receipt.jpg')).toBeInTheDocument();
    expect(screen.getByText('bill.pdf')).toBeInTheDocument();
    const attach = screen.getByRole('button', { name: /attach to a new transaction/i });
    expect(attach).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /import as a statement/i }),
    ).not.toBeInTheDocument();

    // Nothing has been created just by landing here.
    expect(transactionForm).not.toHaveBeenCalled();

    await act(async () => {
      attach.click();
    });

    await waitFor(() => expect(transactionForm).toHaveBeenCalled());
    expect(transactionForm.mock.calls[0][0].initialStagedFiles).toHaveLength(2);
  });

  // One classifier, not two. The worker recorded what each file is when it
  // arrived; the screen must not re-derive it from the File, or the glyph in the
  // list and the destination on offer can disagree about the same file.
  it('follows the kind the worker recorded, not a fresh guess from the file', async () => {
    const recordedAsStatement = item('looks-like-a-receipt.png', 'image/png', {
      entry: {
        name: 'looks-like-a-receipt.png',
        type: 'image/png',
        size: 10,
        kind: 'statement',
        key: 'k',
      },
    });
    mocks.readSharedBundle.mockResolvedValue(bundle([recordedAsStatement]));

    await renderPage();

    expect(
      await screen.findByRole('button', { name: /import as a statement/i }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /attach to a new transaction/i }),
    ).not.toBeInTheDocument();
  });

  // A stored file the worker never classified is not usable, and saying "share
  // receipts and statements separately" about it would be a wrong explanation.
  it('reports an unclassified stored file as unusable, not as a mixed share', async () => {
    const unclassified = item('mystery', '', {
      entry: { name: 'mystery', type: '', size: 10, kind: null, key: 'k' },
    });
    mocks.readSharedBundle.mockResolvedValue(bundle([unclassified]));

    await renderPage();

    expect(
      await screen.findByText(/could not use any of these files/i),
    ).toBeInTheDocument();
    expect(
      screen.queryByText(/receipts and statements need separate shares/i),
    ).not.toBeInTheDocument();
  });

  it('offers the import wizard for a share of statements', async () => {
    mocks.readSharedBundle.mockResolvedValue(
      bundle([item('january.csv', 'text/csv')]),
    );

    await renderPage();

    expect(
      await screen.findByRole('button', { name: /import as a statement/i }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /attach to a new transaction/i }),
    ).not.toBeInTheDocument();
  });

  // Receipts and statements go to different places, so a share holding both
  // gets neither destination rather than a guess about which was meant.
  it('offers no destination for a mixed share, and says why', async () => {
    mocks.readSharedBundle.mockResolvedValue(
      bundle([item('receipt.jpg', 'image/jpeg'), item('january.csv', 'text/csv')]),
    );

    await renderPage();

    expect(
      await screen.findByText(/receipts and statements need separate shares/i),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /attach to a new transaction/i }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /import as a statement/i }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /discard/i })).toBeInTheDocument();
  });

  it('lists a refused file with its reason and offers nothing to do with it', async () => {
    const refused = item('profile.mny', '', {
      entry: {
        name: 'profile.mny',
        type: '',
        size: 999,
        kind: null,
        reason: 'unsupported',
      },
      file: null,
    });
    mocks.readSharedBundle.mockResolvedValue(bundle([refused]));

    await renderPage();

    expect(await screen.findByText('profile.mny')).toBeInTheDocument();
    expect(screen.getByText(/cannot use this kind of file/i)).toBeInTheDocument();
    expect(
      screen.getByText(/could not use any of these files/i),
    ).toBeInTheDocument();
  });

  // An accepted file whose bytes were evicted is unavailable, not refused, and
  // is never silently dropped from a list that would then look complete.
  it('marks an accepted file whose bytes are gone as unavailable', async () => {
    const evicted = item('gone.png', 'image/png', { file: null, missing: true });
    mocks.readSharedBundle.mockResolvedValue(bundle([evicted]));

    await renderPage();

    expect(await screen.findByText('gone.png')).toBeInTheDocument();
    expect(screen.getByText(/no longer on this device/i)).toBeInTheDocument();
  });

  it('explains an expired bundle rather than showing it as empty', async () => {
    mocks.readSharedBundle.mockResolvedValue(
      bundle([item('receipt.jpg', 'image/jpeg')], { expired: true }),
    );

    await renderPage();

    expect(await screen.findByText(/have expired/i)).toBeInTheDocument();
  });

  it('explains a share the worker never caught', async () => {
    searchParams.value = new URLSearchParams('missed=1');

    await renderPage();

    expect(await screen.findByText(/did not reach monize/i)).toBeInTheDocument();
    // Nothing is read from the stash on this path: there is nothing in it.
    expect(mocks.readSharedBundle).not.toHaveBeenCalled();
  });

  it('explains a share the worker could not keep', async () => {
    searchParams.value = new URLSearchParams('error=stash');

    await renderPage();

    expect(
      await screen.findByText(/could not hold on to those files/i),
    ).toBeInTheDocument();
  });

  it('explains a browser with no Cache API instead of failing', async () => {
    mocks.isShareInboxSupported.mockReturnValue(false);

    await renderPage();

    expect(
      await screen.findByText(/cannot receive shared files/i),
    ).toBeInTheDocument();
  });

  it('reports an unknown id as nothing to review', async () => {
    mocks.readSharedBundle.mockResolvedValue(null);

    await renderPage();

    expect(await screen.findByText(/nothing here to review/i)).toBeInTheDocument();
  });

  // Reached from the launcher rather than from the redirect: the newest live
  // bundle is the one the user would have been sent to.
  it('falls back to the newest bundle when no id is given', async () => {
    searchParams.value = new URLSearchParams();
    mocks.listSharedBundles.mockResolvedValue([
      { id: 'newest', createdAt: Date.now(), files: [] },
    ]);
    mocks.readSharedBundle.mockResolvedValue(
      bundle([item('receipt.jpg', 'image/jpeg')]),
    );

    await renderPage();

    await waitFor(() =>
      expect(mocks.readSharedBundle).toHaveBeenCalledWith('newest', VIEWER_ID),
    );
    expect(mocks.listSharedBundles).toHaveBeenCalledWith(VIEWER_ID);
  });

  // A bundle belongs to the first authenticated reader that sees it, so an
  // unknown reader must be shown nothing -- and must not be able to claim
  // anybody's share by landing on this URL. Staying on the loading state is the
  // honest report: we have not looked in the inbox yet.
  it('reads nothing until the reader is known', async () => {
    signIn(null);
    mocks.readSharedBundle.mockResolvedValue(
      bundle([item('receipt.jpg', 'image/jpeg')]),
    );

    await renderPage();

    expect(mocks.readSharedBundle).not.toHaveBeenCalled();
    expect(mocks.listSharedBundles).not.toHaveBeenCalled();
    expect(screen.queryByText('receipt.jpg')).not.toBeInTheDocument();
    expect(screen.queryByText(/nothing here to review/i)).not.toBeInTheDocument();

    // ...and reads it the moment the store answers, without a remount.
    await act(async () => {
      signIn(VIEWER_ID);
    });

    expect(await screen.findByText('receipt.jpg')).toBeInTheDocument();
    expect(mocks.readSharedBundle).toHaveBeenCalledWith('bundle-1', VIEWER_ID);
  });

  // The assistant is a third destination, and it is offered only when a
  // provider can actually answer: a button whose one outcome is "configure a
  // provider first" costs a press to learn nothing.
  describe('the assistant destination', () => {
    it('is not offered when no AI provider is configured', async () => {
      mocks.readSharedBundle.mockResolvedValue(
        bundle([item('receipt.jpg', 'image/jpeg')]),
      );

      await renderPage();

      expect(await screen.findByText('receipt.jpg')).toBeInTheDocument();
      expect(
        screen.queryByRole('button', { name: /send to ai assistant/i }),
      ).not.toBeInTheDocument();
    });

    it('hands the bundle to the chat rather than the files, and leaves it in the stash', async () => {
      aiConfigured.value = true;
      mocks.readSharedBundle.mockResolvedValue(
        bundle([item('receipt.jpg', 'image/jpeg'), item('bill.pdf', 'application/pdf')]),
      );

      await renderPage();

      const send = await screen.findByRole('button', {
        name: /send to ai assistant/i,
      });
      await act(async () => {
        send.click();
      });

      expect(routerMock.push).toHaveBeenCalledWith('/ai?share=bundle-1');
      // The chat discards it once it holds the contents; dropping it here would
      // leave the user with neither the share nor the attachments.
      expect(mocks.discardSharedBundle).not.toHaveBeenCalled();
    });

    it('is offered beside the import wizard for a CSV statement the assistant can read', async () => {
      aiConfigured.value = true;
      mocks.readSharedBundle.mockResolvedValue(
        bundle([item('january.csv', 'text/csv')]),
      );

      await renderPage();

      expect(
        await screen.findByRole('button', { name: /import as a statement/i }),
      ).toBeInTheDocument();
      expect(
        screen.getByRole('button', { name: /send to ai assistant/i }),
      ).toBeInTheDocument();
    });

    // A QIF is a statement the wizard reads and the assistant cannot. Offering
    // the row here would promise something the chat then refuses file by file.
    it('is withheld for a statement type the assistant cannot read', async () => {
      aiConfigured.value = true;
      mocks.readSharedBundle.mockResolvedValue(
        bundle([item('january.qif', 'application/x-qw')]),
      );

      await renderPage();

      expect(
        await screen.findByRole('button', { name: /import as a statement/i }),
      ).toBeInTheDocument();
      expect(
        screen.queryByRole('button', { name: /send to ai assistant/i }),
      ).not.toBeInTheDocument();
    });

    // The stash takes 10 files; the assistant takes 5. A share inside one cap
    // can be outside the other.
    it('is withheld for a share of more files than the assistant accepts', async () => {
      aiConfigured.value = true;
      mocks.readSharedBundle.mockResolvedValue(
        bundle(
          Array.from({ length: 6 }, (_, i) =>
            item(`page-${i}.png`, 'image/png'),
          ),
        ),
      );

      await renderPage();

      expect(
        await screen.findByRole('button', { name: /attach to a new transaction/i }),
      ).toBeInTheDocument();
      expect(
        screen.queryByRole('button', { name: /send to ai assistant/i }),
      ).not.toBeInTheDocument();
    });
  });

  it('discards only after the confirmation is accepted', async () => {
    mocks.readSharedBundle.mockResolvedValue(
      bundle([item('receipt.jpg', 'image/jpeg')]),
    );

    await renderPage();

    const discard = await screen.findByRole('button', { name: /^discard$/i });
    await act(async () => {
      discard.click();
    });
    expect(mocks.discardSharedBundle).not.toHaveBeenCalled();

    // Scoped to the dialog: the trigger button is still in the DOM behind it.
    const dialog = await screen.findByRole('dialog');
    await act(async () => {
      within(dialog).getByRole('button', { name: /^discard$/i }).click();
    });

    await waitFor(() =>
      expect(mocks.discardSharedBundle).toHaveBeenCalledWith('bundle-1'),
    );
  });
});
