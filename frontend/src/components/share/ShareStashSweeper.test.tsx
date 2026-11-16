import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, cleanup } from '@testing-library/react';
import { render } from '@/test/render';
import { ShareStashSweeper } from './ShareStashSweeper';

// The sweeper is what survived `ShareInboxNotice`: the banner's UI was
// redundant, but the app-side lifetime sweep it carried is one of the three
// mechanisms behind INV-SHARE-003, so removing the banner must not remove it.

const pathname = { value: '/dashboard' };
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn(), prefetch: vi.fn(), refresh: vi.fn() }),
  usePathname: () => pathname.value,
  useSearchParams: () => new URLSearchParams(),
}));

const mocks = vi.hoisted(() => ({
  purgeExpiredSharedBundles: vi.fn(),
}));

vi.mock('@/lib/share-inbox', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/share-inbox')>()),
  purgeExpiredSharedBundles: mocks.purgeExpiredSharedBundles,
}));

async function renderSweeper() {
  let result: ReturnType<typeof render>;
  await act(async () => {
    result = render(<ShareStashSweeper />);
  });
  return result!;
}

describe('ShareStashSweeper', () => {
  beforeEach(() => {
    pathname.value = '/dashboard';
    mocks.purgeExpiredSharedBundles.mockResolvedValue(undefined);
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('sweeps the stash on an ordinary page', async () => {
    await renderSweeper();

    expect(mocks.purgeExpiredSharedBundles).toHaveBeenCalledTimes(1);
  });

  it('renders nothing at all', async () => {
    const { container } = await renderSweeper();

    expect(container).toBeEmptyDOMElement();
  });

  // An expired bundle stays readable on the review screen so it can say
  // "expired" instead of "nothing here" -- sweeping there would take the
  // explanation away from the one screen that owes the user one.
  it('does not sweep on the review screen', async () => {
    pathname.value = '/share';

    await renderSweeper();

    expect(mocks.purgeExpiredSharedBundles).not.toHaveBeenCalled();
  });

  // No auth gate: this decides on `createdAt`, not on who is reading, so a
  // signed-out visit still ages a stash out. The banner it came from waited for
  // a reader because it was ALSO an ownership-claiming observation; a sweep is
  // not, so keeping that gate would be inheriting a constraint with no reason.
  // Ownership is enforced where a bundle is read.
  it('sweeps without waiting for a signed-in reader', async () => {
    await renderSweeper();

    expect(mocks.purgeExpiredSharedBundles).toHaveBeenCalledTimes(1);
  });

  // Navigating re-runs it, and the review screen is still excluded on the way
  // back: the gate is on the current path, not on first mount.
  it('re-sweeps on navigation, still skipping the review screen', async () => {
    const { rerender } = await renderSweeper();
    expect(mocks.purgeExpiredSharedBundles).toHaveBeenCalledTimes(1);

    pathname.value = '/share';
    await act(async () => {
      rerender(<ShareStashSweeper />);
    });
    expect(mocks.purgeExpiredSharedBundles).toHaveBeenCalledTimes(1);

    pathname.value = '/transactions';
    await act(async () => {
      rerender(<ShareStashSweeper />);
    });
    expect(mocks.purgeExpiredSharedBundles).toHaveBeenCalledTimes(2);
  });
});
