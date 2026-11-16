import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createTranslator } from 'use-intl';
import {
  RELEASE_1_17_MINOR,
  RELEASE_1_17_TOURS,
  RELEASE_1_17_TRANSACTION_RULES_TOUR,
} from './release-1.17.0';
import { TOUR_ANCHORS } from '../anchors';
import { getReleaseTours, getTourById } from '../registry';
import { isTourOfferable } from '../requirements';
import { isStepReachable } from '../navigation';
import type { TourAnchorId } from '../anchors';

const tour = RELEASE_1_17_TRANSACTION_RULES_TOUR;
const ANCHOR_VALUES = new Set<TourAnchorId>(Object.values(TOUR_ANCHORS));
const step = (id: string) => tour.steps.find((s) => s.id === id);

describe('transaction rules release tour', () => {
  it('is a 1.17 release tour registered under a stable id', () => {
    expect(RELEASE_1_17_MINOR).toBe('1.17');
    expect(tour.id).toBe('release-1.17.0/transaction-rules');
    expect(tour.version).toBe('1.17');
    expect(tour.area).toBe('transactions');
    expect(tour.i18nPrefix).toBe('release.v1_17_0.transactionRules');
    expect(RELEASE_1_17_TOURS).toContain(tour);
    expect(getTourById(tour.id)).toBe(tour);
    expect(getReleaseTours('1.17.2').map((t) => t.id)).toContain(tour.id);
    expect(getReleaseTours('1.16.0').map((t) => t.id)).not.toContain(tour.id);
  });

  it('walks Tools, the list, the editor panels, then the review inbox', () => {
    expect(tour.steps.map((s) => s.id)).toEqual([
      'welcome',
      'tools',
      'rulesLink',
      'list',
      'create',
      'when',
      'if',
      'then',
      'test',
      'reviews',
    ]);
  });

  it('references only declared anchors, one per anchored step', () => {
    const anchored = tour.steps.filter((s) => s.anchorId !== null);
    for (const s of anchored) {
      expect(ANCHOR_VALUES.has(s.anchorId as TourAnchorId)).toBe(true);
    }
    const ids = anchored.map((s) => s.anchorId);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('opens with a route-agnostic welcome', () => {
    const welcome = tour.steps[0];
    expect(welcome.id).toBe('welcome');
    expect(welcome.route).toBeUndefined();
    expect(welcome.routeMatch).toBeUndefined();
    expect(welcome.anchorId).toBeNull();
  });

  it('holds the Tools menu open only for the step inside it', () => {
    // The step pointing at the closed trigger must not carry the flag: the open
    // menu would cover the button it names.
    expect(step('tools')?.anchorId).toBe(TOUR_ANCHORS.navTools);
    expect(step('tools')?.openToolsMenu).toBeUndefined();
    expect(step('rulesLink')?.anchorId).toBe(TOUR_ANCHORS.navRules);
    expect(step('rulesLink')?.openToolsMenu).toBe(true);
    for (const id of ['tools', 'rulesLink']) {
      expect(step(id)?.route).toBe('/dashboard');
      // The phone drawer carries no anchors, as in the introduction tour.
      expect(step(id)?.skipOnMobile).toBe(true);
    }
  });

  it('anchors each screen on a container that renders with zero rules', () => {
    expect(step('list')?.route).toBe('/rules');
    expect(step('list')?.anchorId).toBe(TOUR_ANCHORS.rulesList);
    expect(step('create')?.route).toBe('/rules');
    expect(step('create')?.anchorId).toBe(TOUR_ANCHORS.rulesCreateButton);
    const panels = {
      when: TOUR_ANCHORS.ruleEditorWhen,
      if: TOUR_ANCHORS.ruleEditorIf,
      then: TOUR_ANCHORS.ruleEditorThen,
      test: TOUR_ANCHORS.ruleEditorTest,
    };
    for (const [id, anchor] of Object.entries(panels)) {
      expect(step(id)?.route).toBe('/rules/new');
      expect(step(id)?.anchorId).toBe(anchor);
    }
    expect(step('reviews')?.route).toBe('/ai-reviews');
    expect(step('reviews')?.anchorId).toBe(TOUR_ANCHORS.aiReviewInbox);
  });

  it('is not gated on data and needs no button /rules/new does not render', () => {
    // No rule has to exist: the list card renders its empty state and the
    // editor renders a blank draft. Run on existing transactions is drawn only
    // for a saved rule, so nothing anchors it.
    for (const s of tour.steps) {
      expect(s.fallbackWhenMissing).toBeUndefined();
      expect(s.advance).toBeUndefined();
      expect(s.routeMatch).toBeUndefined();
      expect(s.requires === undefined || s.id === 'reviews').toBe(true);
    }
    for (const s of tour.steps) expect(isStepReachable(s, '/dashboard')).toBe(true);
  });

  it('is owner-only: the tour and the inbox step both need the owner view', () => {
    // The header hides Rules from a delegate and the inbox layout redirects one
    // to the dashboard, so neither can be shown to them.
    expect(tour.requiresData).toBe('ownerView');
    expect(step('reviews')?.requires).toBe('ownerView');
    const base = { transactionEntry: true, accountsExist: true, securitiesExist: true };
    expect(isTourOfferable(tour, { ...base, ownerView: true })).toBe(true);
    expect(isTourOfferable(tour, { ...base, ownerView: false })).toBe(false);
  });
});

describe('transaction rules tour copy', () => {
  const messagesDir = join(
    dirname(fileURLToPath(import.meta.url)),
    '..',
    '..',
    '..',
    'i18n',
    'messages',
  );
  const locales = readdirSync(messagesDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    // A regional variant carries only the leaves that differ from its base.
    .filter((locale) => !['en-GB', 'en-US'].includes(locale));

  it.each(locales)('formats every step in "%s" without an ICU error', (locale) => {
    const messages = JSON.parse(
      readFileSync(join(messagesDir, locale, 'tours.json'), 'utf8'),
    );
    const t = createTranslator({ locale: 'en', messages, namespace: undefined });
    const translate = t as unknown as (key: string) => string;
    for (const s of tour.steps) {
      const base = `${tour.i18nPrefix}.steps.${s.id}`;
      expect(translate(`${base}.title`).length).toBeGreaterThan(0);
      expect(translate(`${base}.body`).length).toBeGreaterThan(0);
    }
    expect(translate(`settings.requires.ownerView`).length).toBeGreaterThan(0);
  });

  it('shows the capture example literally, braces included', () => {
    const messages = JSON.parse(
      readFileSync(join(messagesDir, 'en', 'tours.json'), 'utf8'),
    );
    const t = createTranslator({ locale: 'en', messages, namespace: undefined });
    const body = (t as unknown as (key: string) => string)(
      `${tour.i18nPrefix}.steps.if.body`,
    );
    expect(body).toContain('{name}');
    expect(body).toContain('**Visual**');
    expect(body).toContain('**Expression**');
    expect(body).not.toContain('--');
  });
});
