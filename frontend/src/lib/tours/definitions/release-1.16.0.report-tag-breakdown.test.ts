import { describe, it, expect } from 'vitest';
import {
  RELEASE_1_16_REPORT_TAG_BREAKDOWN_TOUR,
  RELEASE_1_16_TOURS,
} from './release-1.16.0';
import { TOUR_ANCHORS } from '../anchors';
import { getReleaseTours } from '../registry';
import type { TourAnchorId } from '../anchors';

const tour = RELEASE_1_16_REPORT_TAG_BREAKDOWN_TOUR;
const ANCHOR_VALUES = new Set<TourAnchorId>(Object.values(TOUR_ANCHORS));

const step = (id: string) => tour.steps.find((s) => s.id === id);

describe('report tag breakdown release tour', () => {
  it('is a 1.16 release tour registered under a stable id', () => {
    expect(tour.id).toBe('release-1.16.0/report-tag-breakdown');
    expect(tour.version).toBe('1.16');
    expect(tour.area).toBe('reports');
    expect(tour.i18nPrefix).toBe('release.v1_16_0.reportTagBreakdown');
    expect(RELEASE_1_16_TOURS).toContain(tour);
    expect(getReleaseTours('1.16.3').map((t) => t.id)).toContain(tour.id);
  });

  it('goes welcome, breakdown, buckets, finish', () => {
    expect(tour.steps.map((s) => s.id)).toEqual([
      'welcome',
      'breakdown',
      'buckets',
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

  it('anchors the breakdown step on the tag-key select, on Income vs Expenses', () => {
    const breakdown = step('breakdown');
    expect(breakdown?.route).toBe('/reports/income-vs-expenses');
    expect(breakdown?.anchorId).toBe(TOUR_ANCHORS.reportTagBreakdownSelect);
  });

  it('falls back on the breakdown step instead of skipping it', () => {
    // TagKeyBreakdownSelect renders nothing without a KEY:VALUE tag, and that
    // absence is itself worth a sentence -- not a refactor casualty -- so the
    // step must carry a fallback and a short timeout rather than vanish.
    const breakdown = step('breakdown');
    expect(breakdown?.fallbackWhenMissing).toBe(true);
    expect(breakdown?.anchorTimeoutMs).toBeDefined();
    expect(breakdown?.anchorTimeoutMs).toBeLessThan(5000);
  });

  it('leaves the select usable while explaining it', () => {
    expect(step('breakdown')?.allowInteraction).toBe(true);
  });

  it('describes the buckets view without anchoring it', () => {
    // TagKeyBreakdownBuckets only mounts once the reader picks a key, which a
    // passive tour cannot force, so this step points at nothing and stays
    // unobtrusive so it never dims the very card it is describing.
    const buckets = step('buckets');
    expect(buckets?.anchorId).toBeNull();
    expect(buckets?.unobtrusive).toBe(true);
    expect(buckets?.fallbackWhenMissing).toBeUndefined();
  });

  it('never requires the user to press anything to move on', () => {
    for (const s of tour.steps) {
      expect(s.advance).toBeUndefined();
    }
  });

  it('has no data requirement -- the select simply does not render without tags', () => {
    expect(tour.requiresData).toBeUndefined();
    for (const s of tour.steps) {
      expect(s.requires).toBeUndefined();
    }
  });

  it('reaches every step by a route the engine can navigate to', () => {
    for (const s of tour.steps) {
      expect(s.routeMatch).toBeUndefined();
    }
    for (const id of ['breakdown', 'buckets', 'finish']) {
      expect(step(id)?.route).toBe('/reports/income-vs-expenses');
    }
  });

  it('ends on an anchorless card', () => {
    const finish = tour.steps[tour.steps.length - 1];
    expect(finish.id).toBe('finish');
    expect(finish.anchorId).toBeNull();
  });
});
