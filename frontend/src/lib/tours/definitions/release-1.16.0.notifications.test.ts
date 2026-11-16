import { describe, it, expect } from 'vitest';
import {
  RELEASE_1_16_NOTIFICATIONS_TOUR,
  RELEASE_1_16_TOURS,
} from './release-1.16.0';
import { TOUR_ANCHORS } from '../anchors';
import { getReleaseTours } from '../registry';
import type { TourAnchorId } from '../anchors';

const tour = RELEASE_1_16_NOTIFICATIONS_TOUR;
const ANCHOR_VALUES = new Set<TourAnchorId>(Object.values(TOUR_ANCHORS));

const step = (id: string) => tour.steps.find((s) => s.id === id);

describe('notifications release tour', () => {
  it('is a 1.16 release tour registered under a stable id', () => {
    expect(tour.id).toBe('release-1.16.0/notifications');
    expect(tour.version).toBe('1.16');
    expect(tour.area).toBe('settings');
    expect(tour.i18nPrefix).toBe('release.v1_16_0.notifications');
    expect(RELEASE_1_16_TOURS).toContain(tour);
    expect(getReleaseTours('1.16.3').map((t) => t.id)).toContain(tour.id);
  });

  it('goes bell first, then Settings', () => {
    // Order is the argument: the matrix's columns only mean something once the
    // reader knows the bell gets the row whatever the columns say.
    expect(tour.steps.map((s) => s.id)).toEqual([
      'welcome',
      'bell',
      'panel',
      'filters',
      'settings',
      'matrix',
      'push',
      'portfolio',
      'finish',
    ]);
  });

  it('references only declared anchors', () => {
    for (const s of tour.steps) {
      if (s.anchorId !== null) {
        expect(ANCHOR_VALUES.has(s.anchorId)).toBe(true);
      }
      if (s.advance?.type === 'appear' || s.advance?.type === 'disappear') {
        expect(ANCHOR_VALUES.has(s.advance.anchorId)).toBe(true);
      }
    }
  });

  it('opens with a route-agnostic welcome', () => {
    // Launched from the What's New modal, a first step that navigated would
    // collide with that modal's own history.back() as it closes.
    const welcome = tour.steps[0];
    expect(welcome.id).toBe('welcome');
    expect(welcome.route).toBeUndefined();
    expect(welcome.routeMatch).toBeUndefined();
    expect(welcome.anchorId).toBeNull();
  });

  it('holds the notification panel open for every step inside it', () => {
    // The panel closes on a click outside itself, so a `click` advance on the
    // bell would open it and the reader's next click would close it under the
    // step describing its contents. Both in-panel steps must carry the flag --
    // one of them missing it is the panel vanishing mid-tour.
    for (const id of ['panel', 'filters']) {
      expect(step(id)?.openNotificationBell).toBe(true);
    }
    // And the step that points at the closed bell must NOT, or the panel
    // covers the very button it is describing.
    expect(step('bell')?.openNotificationBell).toBeUndefined();
  });

  it('anchors each in-panel step inside the panel it opens', () => {
    expect(step('panel')?.anchorId).toBe(TOUR_ANCHORS.notificationPanel);
    expect(step('filters')?.anchorId).toBe(
      TOUR_ANCHORS.notificationPanelFilters,
    );
  });

  it('does not dim the panel it is describing', () => {
    // On a phone the panel covers the whole viewport, so the dimming frame has
    // nothing outside the cutout to dim and only darkens the panel's edges.
    expect(step('panel')?.unobtrusive).toBe(true);
    // Same reasoning for the step that introduces the Settings card as a whole.
    expect(step('settings')?.unobtrusive).toBe(true);
  });

  it('leaves every control it describes usable', () => {
    // Each of these steps says "try this": the filter chips, the switches that
    // save as they are flipped, Enable on this device, the threshold field. A
    // passive step would cover them with the spotlight's click blocker.
    for (const id of ['filters', 'matrix', 'push', 'portfolio']) {
      expect(step(id)?.allowInteraction).toBe(true);
    }
  });

  it('never requires the user to press anything to move on', () => {
    // Nothing here is a workflow, and a reader who presses nothing must still
    // reach the end: every step advances with Next.
    for (const s of tour.steps) {
      expect(s.advance).toBeUndefined();
    }
  });

  it('runs on every viewport, and for an account with no notifications yet', () => {
    // Every anchor is a container that renders in each state of its block: the
    // panel and its filter strip render over an empty inbox, and the push block
    // renders its "an administrator has not enabled this" message rather than
    // disappearing. A user with nothing in the bell is who this tour is for, so
    // neither a data gate nor a step-level requirement belongs here.
    expect(tour.requiresData).toBeUndefined();
    for (const s of tour.steps) {
      expect(s.requires).toBeUndefined();
      expect(s.skipOnMobile).toBeUndefined();
      expect(s.fallbackWhenMissing).toBeUndefined();
    }
  });

  it('reaches every Settings step by a route the engine can navigate to', () => {
    // No step is pinned to a dynamic route, so `isStepReachable` is true for
    // all of them and Back can land anywhere.
    for (const s of tour.steps) {
      expect(s.routeMatch).toBeUndefined();
    }
    for (const id of ['settings', 'matrix', 'push', 'portfolio']) {
      expect(step(id)?.route).toBe('/settings');
    }
    for (const id of ['bell', 'panel', 'filters']) {
      expect(step(id)?.route).toBe('/dashboard');
    }
  });

  it('ends on an anchorless card', () => {
    const finish = tour.steps[tour.steps.length - 1];
    expect(finish.id).toBe('finish');
    expect(finish.anchorId).toBeNull();
  });
});
