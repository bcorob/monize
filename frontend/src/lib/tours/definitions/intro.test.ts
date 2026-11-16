import { describe, it, expect } from 'vitest';
import { INTRO_TOUR } from './intro';
import { TOUR_ANCHORS } from '../anchors';
import { backTargetIndex } from '../navigation';

const step = (id: string) => INTRO_TOUR.steps.find((s) => s.id === id)!;

describe('introduction tour', () => {
  // Dimming a screen the step is introducing hides the thing being described.
  const PAGE_STEPS = [
    'dashboard',
    'tools',
    'accounts',
    'transactions',
    'bills',
    'investments',
    'budgets',
    'reports',
  ];

  it.each(PAGE_STEPS)('leaves the page visible on the "%s" step', (id) => {
    expect(step(id).unobtrusive).toBe(true);
  });

  it('still rings the button on the undimmed anchored steps', () => {
    // Undimmed but anchored: the ring is what keeps the step pointing at the
    // control its copy names.
    expect(step('accounts').anchorId).toBe(TOUR_ANCHORS.accountsAddButton);
    expect(step('transactions').anchorId).toBe(TOUR_ANCHORS.transactionsNewButton);
  });

  it('keeps the in-form steps dimmed', () => {
    // These point at one field inside an open form, where the dim is the point.
    for (const id of ['fields', 'splits', 'currencyField']) {
      expect(step(id).unobtrusive).toBeUndefined();
    }
  });

  it('holds the Tools menu open and points at its contents', () => {
    const tools = step('tools');
    expect(tools.openToolsMenu).toBe(true);
    // The panel, not the closed trigger, so the copy about what is inside has
    // the contents on screen and the card is positioned clear of them.
    expect(tools.anchorId).toBe(TOUR_ANCHORS.navToolsMenu);
    expect(tools.placement).toBe('right');
  });

  it('requires something to record before walking through the form', () => {
    // A user with no accounts, payees or categories learns nothing from the
    // New Transaction form, so the whole detour is omitted for them.
    for (const id of [
      'createTransaction',
      'fields',
      'splits',
      'currencyField',
      'closeForm',
    ]) {
      expect(step(id).requires).toBe('transactionEntry');
    }
    // The surrounding page steps stay unconditional.
    expect(step('transactions').requires).toBeUndefined();
    expect(step('bills').requires).toBeUndefined();
  });

  describe('account detail discovery', () => {
    const ids = INTRO_TOUR.steps.map((s) => s.id);

    it('follows the Accounts step straight into opening a detail page', () => {
      expect(ids.slice(ids.indexOf('accounts'), ids.indexOf('accounts') + 3)).toEqual([
        'accounts',
        'openAccountDetail',
        'accountDetailView',
      ]);
      // ...and hands back to the register step the tour already had.
      expect(ids[ids.indexOf('accountDetailView') + 1]).toBe('transactions');
    });

    it('asks for the Details page without anchoring on a row', () => {
      // An account list has many rows, so a shared per-row anchor would break
      // anchor uniqueness and move under filtering. The route change is the
      // signal instead -- and it is reachable by long-press on mobile, which a
      // desktop-only icon anchor would not be.
      expect(step('openAccountDetail')).toMatchObject({
        route: '/accounts',
        anchorId: null,
        unobtrusive: true,
        advance: { type: 'route', route: '/accounts/' },
      });
      expect(step('openAccountDetail').skipOnMobile).toBeUndefined();
    });

    it('parks its card clear of the row actions it asks the user to use', () => {
      // The coach mark parks in a bottom corner, and the default is the right
      // one -- where every list puts its row actions. CI caught the card
      // intercepting the click on Details at a 720px-tall viewport.
      expect(step('openAccountDetail').placement).toBe('left');
    });

    it('shows the explanation on whichever account was opened', () => {
      // `routeMatch` is the prefix; the id belongs to the user's choice.
      expect(step('accountDetailView')).toMatchObject({
        route: '/accounts',
        routeMatch: '/accounts/',
        anchorId: null,
        unobtrusive: true,
      });
      expect(step('accountDetailView').skipOnMobile).toBeUndefined();
    });

    it('omits both steps for a user with no account to open', () => {
      for (const id of ['openAccountDetail', 'accountDetailView']) {
        expect(step(id).requires).toBe('accountsExist');
      }
    });

    it('leaves the record-a-transaction requirement where it was', () => {
      // `accountsExist` asks a different question of the same list; the form
      // detour must not start gating on "has a Details page" by accident.
      for (const id of [
        'createTransaction',
        'fields',
        'splits',
        'currencyField',
        'closeForm',
      ]) {
        expect(step(id).requires).toBe('transactionEntry');
      }
    });

    it('never lands Back on the step it cannot navigate to', () => {
      // From the register step, with the user no longer on an account page:
      // '/accounts/<id>' cannot be reconstructed, so Back has to reach past it.
      const detailIndex = INTRO_TOUR.steps.findIndex(
        (s) => s.id === 'accountDetailView',
      );
      expect(
        backTargetIndex(INTRO_TOUR.steps, detailIndex + 1, '/transactions'),
      ).toBe(detailIndex - 1);
      // On the detail page itself it is replayable like any other step.
      expect(
        backTargetIndex(INTRO_TOUR.steps, detailIndex + 1, '/accounts/abc'),
      ).toBe(detailIndex);
    });
  });

  it('highlights the form buttons on the close-the-form step', () => {
    const close = step('closeForm');
    expect(close.anchorId).toBe(TOUR_ANCHORS.transactionFormActions);
    expect(close.placement).toBe('top');
    // Still driven by the form going away, however the user closes it.
    expect(close.advance).toEqual({
      type: 'disappear',
      anchorId: TOUR_ANCHORS.transactionForm,
    });
  });
});
