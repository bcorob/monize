import { describe, it, expect, afterEach } from 'vitest';
import { backTargetIndex, isStepReachable } from './navigation';
import { TOUR_ANCHORS } from './anchors';
import type { TourStep } from './types';

const STEPS: readonly TourStep[] = [
  { id: 'welcome', anchorId: null },
  {
    id: 'openForm',
    anchorId: TOUR_ANCHORS.transactionsNewButton,
    advance: { type: 'appear', anchorId: TOUR_ANCHORS.transactionForm },
  },
  {
    id: 'fields',
    anchorId: TOUR_ANCHORS.transactionFields,
    skipOnBack: true,
  },
  {
    id: 'closeForm',
    anchorId: TOUR_ANCHORS.transactionFormActions,
    skipOnBack: true,
  },
  { id: 'bills', anchorId: null },
];

/** The account-detail shape: a step only the user's own navigation can reach. */
const DYNAMIC_STEPS: readonly TourStep[] = [
  { id: 'accounts', route: '/accounts', anchorId: null },
  {
    id: 'openAccountDetail',
    route: '/accounts',
    anchorId: null,
    advance: { type: 'route', route: '/accounts/' },
  },
  {
    id: 'accountDetailView',
    route: '/accounts',
    routeMatch: '/accounts/',
    anchorId: null,
  },
  { id: 'transactions', route: '/transactions', anchorId: null },
];

function mountAnchor(id: string) {
  const el = document.createElement('div');
  el.setAttribute('data-tour-id', id);
  document.body.appendChild(el);
}

afterEach(() => {
  document.body.innerHTML = '';
});

describe('backTargetIndex', () => {
  it('has no target on the first step', () => {
    expect(backTargetIndex(STEPS, 0)).toBeNull();
  });

  it('steps back one when the previous step is replayable', () => {
    expect(backTargetIndex(STEPS, 1)).toBe(0);
  });

  it('walks past in-form steps once the form is gone', () => {
    // From "bills": neither in-form anchor is mounted, so Back has to land on
    // the step that opens the form again rather than inside it.
    expect(backTargetIndex(STEPS, 4)).toBe(1);
  });

  it('keeps in-form steps replayable while the form is open', () => {
    mountAnchor(TOUR_ANCHORS.transactionFields);
    expect(backTargetIndex(STEPS, 3)).toBe(2);
  });

  it('skips a step whose appear target is already on the page', () => {
    // The form is open, so "open the form" would advance again the frame it is
    // shown: Back has to reach past it to the step before.
    mountAnchor(TOUR_ANCHORS.transactionForm);
    mountAnchor(TOUR_ANCHORS.transactionFields);
    expect(backTargetIndex(STEPS, 2)).toBe(0);
  });

  it('offers that step again once its target is gone', () => {
    expect(backTargetIndex(STEPS, 2)).toBe(1);
  });

  it('walks past a dynamic-route step once the user has left that route', () => {
    // '/accounts/<id>' holds an id the tour never knew, so the engine would
    // push '/accounts' at a step that only matches '/accounts/' and hang there
    // behind an overlay that renders nothing. Back reaches the prompt instead.
    expect(backTargetIndex(DYNAMIC_STEPS, 3, '/transactions')).toBe(1);
  });

  it('keeps it replayable while the user is still on the detail page', () => {
    expect(backTargetIndex(DYNAMIC_STEPS, 3, '/accounts/abc-123')).toBe(2);
  });
});

describe('isStepReachable', () => {
  it('can reach any step that does not pin a dynamic route', () => {
    expect(
      isStepReachable({ id: 'x', route: '/accounts', anchorId: null }, '/dashboard'),
    ).toBe(true);
  });

  it('cannot construct a route whose prefix its own route does not satisfy', () => {
    const step: TourStep = {
      id: 'accountDetailView',
      route: '/accounts',
      routeMatch: '/accounts/',
      anchorId: null,
    };
    expect(isStepReachable(step, '/accounts')).toBe(false);
    expect(isStepReachable(step, '/accounts/abc-123')).toBe(true);
  });

  it('can reach a step whose own route satisfies the prefix', () => {
    // The foreign-currency tour's report step: a query string the pathname does
    // not carry, so `routeMatch` exists only to make the arrival check work.
    expect(
      isStepReachable(
        {
          id: 'report',
          route: '/reports?category=insights',
          routeMatch: '/reports',
          anchorId: null,
        },
        '/dashboard',
      ),
    ).toBe(true);
  });
});
