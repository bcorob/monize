import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  render,
  screen,
  fireEvent,
  waitFor,
  cleanup,
  within,
} from '@/test/render';
import toast from 'react-hot-toast';

const resetProgress = vi.fn().mockResolvedValue({ reset: true });
vi.mock('@/lib/tours-api', () => ({
  toursApi: {
    resetProgress: () => resetProgress(),
    saveProgress: vi.fn().mockResolvedValue({ saved: true }),
  },
}));

// The requirement lookup is stubbed so the three states it can be in -- not
// resolved, met, unmet -- are each reachable from a test rather than racing an
// asynchronous fetch mid-assertion.
const requirements = vi.fn<() => Record<string, boolean> | null>(() => ({
  transactionEntry: true,
  securitiesExist: true,
}));
vi.mock('@/hooks/useTourRequirements', () => ({
  useTourRequirements: () => requirements(),
}));

import { TourCatalog } from './TourCatalog';
import { useTourStore } from '@/store/tourStore';
import { ALL_TOURS, INTRO_TOUR } from '@/lib/tours/registry';
import { tourStepCount } from '@/lib/tours/catalog';

const INTRO_TITLE = 'Introduction to Monize';
const FX_TITLE = 'Foreign currency transactions';
const SECURITY_TITLE = 'Security detail page';

beforeEach(() => {
  resetProgress.mockClear();
  requirements.mockReturnValue({
    transactionEntry: true,
    securitiesExist: true,
    ownerView: true,
  });
  useTourStore.setState({
    active: null,
    progress: { 'intro/basics': { status: 'completed', updatedAt: 'now' } },
    progressLoaded: true,
  });
  window.matchMedia = vi.fn().mockImplementation((q: string) => ({
    matches: q.includes('min-width'),
    media: q,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }));
});

afterEach(() => cleanup());

/** The row whose title matches, so status and button assertions stay scoped. */
function rowFor(title: string) {
  return screen.getByText(title).closest('li') as HTMLElement;
}

function buttonIn(title: string) {
  return within(rowFor(title)).getByRole('button');
}

describe('TourCatalog', () => {
  it('lists every tour the app knows about, expanded', () => {
    render(<TourCatalog />);

    expect(screen.getAllByRole('listitem')).toHaveLength(ALL_TOURS.length);
    // The release tours are otherwise only reachable from the What's New modal.
    expect(screen.getByText(INTRO_TITLE)).toBeInTheDocument();
    expect(screen.getByText(FX_TITLE)).toBeInTheDocument();
    expect(screen.getByText("What's New digest")).toBeInTheDocument();
    expect(screen.getByText(SECURITY_TITLE)).toBeInTheDocument();
  });

  it('groups the tours under their area headings', () => {
    render(<TourCatalog />);

    const headings = screen
      .getAllByRole('heading', { level: 2 })
      .map((h) => h.textContent);
    expect(headings).toContain('Getting started');
    expect(headings).toContain('Transactions');
    expect(headings).toContain('Investments');
    expect(headings).toContain('Settings');
    // An area with no tours is not given an empty heading.
    expect(headings).not.toContain('Budgets');
  });

  it('shows a gated tour disabled with a reason rather than hiding it', () => {
    // This is the case the old Settings list dropped entirely: a user with no
    // securities could not tell the tour existed. A catalog that silently
    // changes size is what this page exists to replace.
    requirements.mockReturnValue({
      transactionEntry: true,
      securitiesExist: false,
      ownerView: true,
    });
    render(<TourCatalog />);

    expect(screen.getAllByRole('listitem')).toHaveLength(ALL_TOURS.length);
    const row = rowFor(SECURITY_TITLE);
    expect(within(row).getByRole('button')).toBeDisabled();
    expect(within(row).getByText(/Add a security first/)).toBeInTheDocument();

    // The ungated tours are untouched.
    expect(buttonIn(FX_TITLE)).toBeEnabled();
  });

  it('does not claim a tour is blocked before the lookup answers', () => {
    // Unresolved is not unmet. Naming a missing prerequisite before anyone has
    // looked tells the user something nobody knows yet.
    requirements.mockReturnValue(null);
    render(<TourCatalog />);

    const row = rowFor(SECURITY_TITLE);
    const button = within(row).getByRole('button');
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute('aria-busy', 'true');
    expect(within(row).queryByText(/Add a security first/)).toBeNull();
    expect(within(row).getByText(/Checking whether you can/)).toBeInTheDocument();

    // An ungated tour is startable while a gated one is still being checked.
    expect(buttonIn(FX_TITLE)).toBeEnabled();
  });

  it('leaves an ungated tour startable and quiet about requirements', () => {
    render(<TourCatalog />);
    const row = rowFor(INTRO_TITLE);
    expect(within(row).getByRole('button')).toBeEnabled();
    expect(within(row).queryByText(/Checking whether you can/)).toBeNull();
  });

  it('shows step count, release line and viewed state', () => {
    useTourStore.setState({
      progress: {
        'intro/basics': { status: 'completed', updatedAt: 'now' },
        'release-1.13.0/settings': { status: 'dismissed', updatedAt: 'now' },
      },
    });
    render(<TourCatalog />);

    // Evergreen: no release line. The count is derived, so adding a step to
    // the introduction does not make this a stale literal to chase.
    expect(
      within(rowFor(INTRO_TITLE)).getByText(
        `${tourStepCount(INTRO_TOUR)} steps · Viewed`,
      ),
    ).toBeInTheDocument();
    expect(
      within(rowFor("What's New digest")).getByText(
        '3 steps · Added in 1.13 · Left early',
      ),
    ).toBeInTheDocument();
    // Never started: no progress entry at all.
    expect(
      within(rowFor(FX_TITLE)).getByText(
        '14 steps · Added in 1.13 · Not viewed',
      ),
    ).toBeInTheDocument();
  });

  it('offers Retake for a viewed tour and Start for an unseen one', () => {
    render(<TourCatalog />);
    expect(buttonIn(INTRO_TITLE)).toHaveTextContent('Retake');
    expect(buttonIn(FX_TITLE)).toHaveTextContent('Start');
  });

  it('starts the tour whose button was clicked', () => {
    render(<TourCatalog />);
    fireEvent.click(buttonIn(FX_TITLE));
    expect(useTourStore.getState().active?.tour.id).toBe(
      'release-1.13.0/foreign-currency',
    );
  });

  it('restarts the introduction tour from its row', () => {
    render(<TourCatalog />);
    fireEvent.click(buttonIn(INTRO_TITLE));
    expect(useTourStore.getState().active?.tour.id).toBe('intro/basics');
  });

  it('resets tour progress and clears the local map', async () => {
    render(<TourCatalog />);
    fireEvent.click(screen.getByRole('button', { name: 'Reset tour progress' }));
    await waitFor(() => expect(resetProgress).toHaveBeenCalled());
    expect(useTourStore.getState().progress).toEqual({});
    expect(toast.success).toHaveBeenCalled();
  });

  it('reports a failed reset and keeps the recorded progress', async () => {
    resetProgress.mockRejectedValueOnce(new Error('nope'));
    render(<TourCatalog />);
    fireEvent.click(screen.getByRole('button', { name: 'Reset tour progress' }));
    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    expect(useTourStore.getState().progress).toHaveProperty('intro/basics');
  });
});
