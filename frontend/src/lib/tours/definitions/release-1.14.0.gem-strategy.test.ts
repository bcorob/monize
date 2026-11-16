import { describe, it, expect } from 'vitest';
import {
  RELEASE_1_14_GEM_STRATEGY_TOUR,
  RELEASE_1_14_TOURS,
} from './release-1.14.0';
import { TOUR_ANCHORS } from '../anchors';
import { getReleaseTours } from '../registry';
import { isTourOfferable } from '../requirements';
import type { TourAnchorId } from '../anchors';
import enTours from '@/i18n/messages/en/tours.json';

const tour = RELEASE_1_14_GEM_STRATEGY_TOUR;
const ANCHOR_VALUES = new Set<TourAnchorId>(Object.values(TOUR_ANCHORS));
const REPORT_ROUTE = '/reports/gem-strategy';

/** Steps whose anchor lives inside the settings form, in the order visited. */
const SETTINGS_STEPS = [
  'addInstruments',
  'roles',
  'accounts',
  'timingAndCosts',
  'save',
] as const;

describe('GEM strategy release tour', () => {
  it('is a 1.14 release tour registered under a stable id', () => {
    expect(tour.id).toBe('release-1.14.0/gem-strategy');
    expect(tour.version).toBe('1.14');
    expect(tour.area).toBe('reports');
    expect(tour.i18nPrefix).toBe('release.v1_14_0.gemStrategy');
    expect(RELEASE_1_14_TOURS).toContain(tour);
  });

  it('is discoverable from any patch release in the same minor', () => {
    expect(getReleaseTours('1.14.2').map((t) => t.id)).toContain(tour.id);
  });

  it('is offered to users who own no securities', () => {
    // The primary audience. A `securitiesExist` gate (or any other) would hide
    // the tour from exactly the people whose roles are empty, which is what the
    // instrument step exists to explain.
    expect(tour.requiresData).toBeUndefined();
    for (const step of tour.steps) {
      expect(step.requires).toBeUndefined();
    }
  });

  it('stays listed on the offer surfaces for a user with nothing configured', () => {
    // What the offer surfaces (What's New, Settings) actually call. Asserting
    // through it, rather than only on `requiresData`, is what fails if the tour
    // is gated later: a user with no accounts and no securities still sees it,
    // and it is listed before the lookups have even resolved.
    const nothing = {
      transactionEntry: false,
      accountsExist: false,
      securitiesExist: false,
      ownerView: true,
    };
    expect(isTourOfferable(tour, nothing)).toBe(true);
    expect(isTourOfferable(tour, null)).toBe(true);
  });

  it('sets the strategy up before reading its output', () => {
    // Order matters more than the step list here: a user with no instruments has
    // an empty report, so explaining the cards first describes blanks. Settings
    // comes first, then the Overview walk has something in it.
    expect(tour.steps.map((s) => s.id)).toEqual([
      'welcome',
      'findReport',
      'page',
      'openSettings',
      'addInstruments',
      'roles',
      'accounts',
      'timingAndCosts',
      'save',
      'tabs',
      'summary',
      'action',
      'reasoning',
      'finish',
    ]);
  });

  it('puts every settings step ahead of every report-reading step', () => {
    const ids = tour.steps.map((s) => s.id);
    const lastSettings = Math.max(
      ...SETTINGS_STEPS.map((id) => ids.indexOf(id)),
    );
    const firstReading = Math.min(
      ...['summary', 'action', 'reasoning'].map((id) => ids.indexOf(id)),
    );
    expect(lastSettings).toBeLessThan(firstReading);
    // And the shortcut precedes the pickers it fills in.
    expect(ids.indexOf('addInstruments')).toBeLessThan(ids.indexOf('roles'));
  });

  it('references only declared anchors', () => {
    for (const step of tour.steps) {
      if (step.anchorId !== null) {
        expect(ANCHOR_VALUES.has(step.anchorId)).toBe(true);
      }
      if (step.advance?.type === 'appear' || step.advance?.type === 'disappear') {
        expect(ANCHOR_VALUES.has(step.advance.anchorId)).toBe(true);
      }
    }
  });

  it('opens with a route-agnostic welcome', () => {
    // Launched from the What's New modal, a first step that navigated would
    // collide with that modal's own history.back() as it closes.
    const [welcome] = tour.steps;
    expect(welcome.id).toBe('welcome');
    expect(welcome.route).toBeUndefined();
    expect(welcome.routeMatch).toBeUndefined();
    expect(welcome.anchorId).toBeNull();
  });

  it('forces the Investment category so the report card is on screen', () => {
    const step = tour.steps.find((s) => s.id === 'findReport');
    // The listing remembers its category filter across visits, so without the
    // override the card the step points at can simply be filtered out.
    expect(step?.route).toBe('/reports?category=investment');
    // A pathname carries no query, so the "am I there yet" check needs this.
    expect(step?.routeMatch).toBe('/reports');
    expect(step?.anchorId).toBe(TOUR_ANCHORS.reportGemStrategy);
  });

  it('advances off the report card by route, not by click', () => {
    const step = tour.steps.find((s) => s.id === 'findReport');
    // Clicking the card navigates; a click advance would race its own
    // navigation.
    expect(step?.advance).toEqual({ type: 'route', route: REPORT_ROUTE });
    // A search box or hidden category can still filter the card out: say so
    // rather than leaving a hole in the step counter.
    expect(step?.fallbackWhenMissing).toBe(true);
    expect(step?.anchorTimeoutMs).toBe(4000);
  });

  it('keeps every on-page step on the GEM report route', () => {
    const onPage = tour.steps.filter(
      (s) => s.anchorId !== null && s.id !== 'findReport',
    );
    expect(onPage).toHaveLength(11);
    for (const step of onPage) {
      expect(step.route).toBe(REPORT_ROUTE);
    }
  });

  it('opens the settings tab through the highlighted button', () => {
    const step = tour.steps.find((s) => s.id === 'openSettings');
    expect(step?.anchorId).toBe(TOUR_ANCHORS.gemStrategyEditSettings);
    // Safe as a click: it switches an in-page tab rather than navigating.
    expect(step?.advance).toEqual({ type: 'click' });
  });

  it('explains itself when the settings form does not load', () => {
    // The first settings step is the one that waits on the form's accounts and
    // securities fetch, so it carries the slow-load stand-in.
    const step = tour.steps.find((s) => s.id === 'addInstruments');
    expect(step?.anchorId).toBe(TOUR_ANCHORS.gemSettingsAssets);
    expect(step?.fallbackWhenMissing).toBe(true);
    expect(step?.anchorTimeoutMs).toBe(8000);
  });

  it('waits for the Overview panel before describing it', () => {
    // The engine navigates by route, and the tabs are in-page, so nothing about
    // a route match can guarantee the Overview panel is mounted. Without this
    // advance the three reading steps would race the user's tab click and get
    // skipped as missing anchors.
    const step = tour.steps.find((s) => s.id === 'tabs');
    expect(step?.advance).toEqual({
      type: 'appear',
      anchorId: TOUR_ANCHORS.gemStrategyOverviewCards,
    });
  });

  it('anchors the instrument step to the always-mounted assets card', () => {
    const step = tour.steps.find((s) => s.id === 'addInstruments');
    // Not the conditional fill-missing-roles box: that disappears the moment
    // every role is filled, and an active anchor going away mid-step reads as
    // the tour breaking. The card is there in both states.
    expect(step?.anchorId).toBe(TOUR_ANCHORS.gemSettingsAssets);
  });

  it('never requires a write to advance', () => {
    // This is the line the tour holds. Every settings step is *actionable* --
    // `allowInteraction` keeps the control usable so the user can fill the form
    // in while reading -- but none of them advances on the action. The advance is
    // the default Next throughout, so a user who presses nothing still reaches
    // the end, and no create, save or mark-executed is ever a precondition.
    for (const id of SETTINGS_STEPS) {
      const step = tour.steps.find((s) => s.id === id);
      expect(step, id).toBeDefined();
      expect(step?.advance, id).toBeUndefined();
      expect(step?.allowInteraction, id).toBe(true);
    }
  });

  it('drives no mutation from any step in the tour', () => {
    // The three interactive advances are a navigation, a tab switch, and the
    // Overview panel mounting. None of them is produced by a write, so nothing
    // in the tour can stall until the user changes data.
    const advances = tour.steps
      .map((s) => s.advance)
      .filter((a): a is NonNullable<typeof a> => a !== undefined);
    expect(advances).toEqual([
      { type: 'route', route: REPORT_ROUTE },
      { type: 'click' },
      { type: 'appear', anchorId: TOUR_ANCHORS.gemStrategyOverviewCards },
    ]);
  });

  it('ends on a route-agnostic card that does not force a tab change', () => {
    const finish = tour.steps[tour.steps.length - 1];
    expect(finish.id).toBe('finish');
    expect(finish.anchorId).toBeNull();
    // The user may have edited a field while reading; navigating back to
    // Overview would trip the unsaved-changes guard. The copy says how instead.
    expect(finish.route).toBeUndefined();
    expect(finish.routeMatch).toBeUndefined();
  });

  it('shows every step on a narrow viewport', () => {
    // The copy names cards and fields, never "the left card" or "the right
    // side", so nothing here depends on the wide layout.
    for (const step of tour.steps) {
      expect(step.skipOnMobile, step.id).toBeUndefined();
    }
  });

  it('stays a single tour rather than a configured/unconfigured pair', () => {
    const gemTours = RELEASE_1_14_TOURS.filter((t) =>
      t.id.includes('gem-strategy'),
    );
    expect(gemTours).toEqual([tour]);
  });
});

describe('GEM strategy tour copy', () => {
  const copy = enTours.release.v1_14_0.gemStrategy;
  const steps = copy.steps as Record<
    string,
    { title: string; body: string; fallbackBody?: string }
  >;
  const allText = Object.values(steps)
    .flatMap((s) => [s.title, s.body, s.fallbackBody ?? ''])
    .join(' ');

  it('carries a title and body for every step', () => {
    expect(copy.title).toBeTruthy();
    for (const step of tour.steps) {
      expect(steps[step.id]?.title, step.id).toBeTruthy();
      expect(steps[step.id]?.body, step.id).toBeTruthy();
    }
  });

  it('supplies a fallback body for exactly the steps that can miss their anchor', () => {
    const withFallback = tour.steps
      .filter((s) => s.fallbackWhenMissing)
      .map((s) => s.id);
    expect(withFallback).toEqual(['findReport', 'addInstruments']);
    for (const id of withFallback) {
      expect(steps[id]?.fallbackBody, id).toBeTruthy();
    }
    // A fallbackBody on a step that can never fall back is dead copy every
    // translator still has to carry.
    for (const step of tour.steps) {
      if (!step.fallbackWhenMissing) {
        expect(steps[step.id]?.fallbackBody, step.id).toBeUndefined();
      }
    }
  });

  it('never claims Monize trades for the user', () => {
    // The copy's whole job on this report. A rewrite that drops these is the
    // failure this test exists to catch.
    //
    // Deliberately not asserted on `welcome`: the opening step is a two-sentence
    // hook describing the mechanism, and the disclaimers were cut from it as
    // preamble. They belong where a user could actually mistake the screen for a
    // broker, which is the three steps below.
    expect(steps.openSettings.body).toMatch(/buys an instrument/i);
    expect(steps.action.body).toMatch(/never sends an order to your broker/i);
    expect(steps.save.body).toMatch(/does not place a trade/i);
  });

  it('separates adding a Monize record from buying the investment', () => {
    // The fill-missing shortcut creates security rows immediately. A user who
    // reads that as "GEM bought this for me" has been actively misled.
    expect(steps.addInstruments.body).toMatch(
      /creates instrument records in Monize (immediately|straight away)/i,
    );
    // And that they land before the configuration is saved, which is the part
    // users are surprised by.
    expect(steps.addInstruments.body).toMatch(/before you save/i);
    expect(steps.addInstruments.body).toMatch(/does not buy anything/i);
    // And it must say what to do when the shortcut is not on screen, since the
    // step is anchored to the card that is always there.
    expect(steps.addInstruments.body).toMatch(
      /if the shortcut is not shown, your roles are already filled/i,
    );
  });

  it('presents the suggested instruments as examples, not advice', () => {
    // Asserted where the suggestions actually appear rather than on `welcome`,
    // which is now a two-sentence hook with the disclaimers cut out of it.
    expect(steps.addInstruments.body).toMatch(/not a recommendation/i);
    expect(steps.addInstruments.body).toMatch(
      /check every symbol, exchange, and currency/i,
    );
    expect(allText).not.toMatch(/\b(recommended|best for you|right for you)\b/i);
  });

  it('describes the backtest as a model rather than a forecast', () => {
    expect(steps.tabs.body).toMatch(/model, not a forecast or promise/i);
  });

  it('keeps the risk-free role a benchmark, never a risk-free investment', () => {
    expect(steps.roles.body).toMatch(/Risk-free benchmark/);
    expect(allText).not.toMatch(/risk-free investment/i);
  });

  it('says missing data stays missing rather than reading as zero', () => {
    expect(steps.summary.body).toMatch(/never as zero/i);
  });

  it('uses no double hyphen as UI punctuation', () => {
    // `--` is this repo's comment style and renders literally on screen.
    expect(allText).not.toContain('--');
  });

  it('names no desktop-only position', () => {
    // The tour runs on every viewport, and the report stacks on narrow screens.
    expect(allText).not.toMatch(/\b(the left card|the right side|on the left|on the right)\b/i);
  });
});
