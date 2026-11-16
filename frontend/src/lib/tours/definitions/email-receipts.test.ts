import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createTranslator } from 'use-intl';
import { EMAIL_RECEIPTS_TOUR } from './email-receipts';
import { TOUR_ANCHORS } from '../anchors';
import { ALL_TOURS, getReleaseTours, getTourById } from '../registry';
import { isTourOfferable } from '../requirements';
import { isStepReachable } from '../navigation';
import type { TourAnchorId } from '../anchors';

const tour = EMAIL_RECEIPTS_TOUR;
const ANCHOR_VALUES = new Set<TourAnchorId>(Object.values(TOUR_ANCHORS));
const step = (id: string) => tour.steps.find((s) => s.id === id);
const HUB_ROUTE = '/email-receipts?tab=profiles';

describe('email receipts tour', () => {
  it('is registered under a stable id and offered from the 1.18 What\'s New', () => {
    expect(tour.id).toBe('email-receipts/basics');
    expect(tour.area).toBe('transactions');
    expect(tour.i18nPrefix).toBe('emailReceipts.basics');
    expect(tour.version).toBe('1.18');
    expect(ALL_TOURS).toContain(tour);
    expect(getTourById(tour.id)).toBe(tour);
    expect(getReleaseTours('1.18.0').map((t) => t.id)).toContain(tour.id);
    expect(getReleaseTours('1.17.0').map((t) => t.id)).not.toContain(tour.id);
    expect(getReleaseTours('1.19.0').map((t) => t.id)).not.toContain(tour.id);
  });

  it('walks the purpose, the AI requirement, the provider, the hub, then the inbox', () => {
    expect(tour.steps.map((s) => s.id)).toEqual([
      'welcome',
      'aiRequired',
      'aiProviders',
      'tabs',
      'uncovered',
      'profiles',
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

  it('opens with two route-agnostic cards and closes with one', () => {
    for (const id of ['welcome', 'aiRequired', 'reviews']) {
      const s = step(id);
      expect(s?.route).toBeUndefined();
      expect(s?.routeMatch).toBeUndefined();
      expect(s?.anchorId).toBeNull();
    }
  });

  it('never navigates to the AI review inbox, which is empty for a new user', () => {
    for (const s of tour.steps) expect(s.route).not.toBe('/ai-reviews');
    expect(step('reviews')?.requires).toBeUndefined();
  });

  it('points at the provider list on the AI settings page', () => {
    expect(step('aiProviders')?.route).toBe('/settings/ai');
    expect(step('aiProviders')?.anchorId).toBe(TOUR_ANCHORS.aiProviderList);
  });

  it('keeps the three hub steps on one URL the engine can reach', () => {
    // The engine compares pathnames only, so one ?tab= serves every step.
    const anchors = {
      tabs: TOUR_ANCHORS.emailReceiptsTabs,
      uncovered: TOUR_ANCHORS.emailReceiptsUncovered,
      profiles: TOUR_ANCHORS.emailReceiptsProfiles,
    };
    for (const [id, anchor] of Object.entries(anchors)) {
      expect(step(id)?.route).toBe(HUB_ROUTE);
      expect(step(id)?.routeMatch).toBe('/email-receipts');
      expect(step(id)?.anchorId).toBe(anchor);
      expect(isStepReachable(step(id)!, '/email-receipts')).toBe(true);
    }
  });

  it('stands in with a centered card where the view is empty for a new user', () => {
    for (const id of ['uncovered', 'profiles']) {
      expect(step(id)?.fallbackWhenMissing).toBe(true);
      expect(step(id)?.anchorTimeoutMs).toBe(2500);
      expect(step(id)?.unobtrusive).toBeUndefined();
    }
    expect(step('tabs')?.fallbackWhenMissing).toBeUndefined();
  });

  it('is owner-only', () => {
    expect(tour.requiresData).toBe('ownerView');
    const base = { transactionEntry: true, accountsExist: true, securitiesExist: true };
    expect(isTourOfferable(tour, { ...base, ownerView: true })).toBe(true);
    expect(isTourOfferable(tour, { ...base, ownerView: false })).toBe(false);
  });
});

describe('email receipts tour copy', () => {
  const messagesDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'i18n', 'messages');
  const locales = readdirSync(messagesDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    // A regional variant carries only the leaves that differ from its base.
    .filter((locale) => !['en-GB', 'en-US'].includes(locale));

  const keys = [
    `${tour.i18nPrefix}.title`,
    ...tour.steps.flatMap((s) => {
      const base = `${tour.i18nPrefix}.steps.${s.id}`;
      return [
        `${base}.title`,
        `${base}.body`,
        ...(s.fallbackWhenMissing ? [`${base}.fallbackBody`] : []),
      ];
    }),
  ];

  it.each(locales)('formats every title, body and fallback in "%s" without an ICU error', (locale) => {
    const messages = JSON.parse(readFileSync(join(messagesDir, locale, 'tours.json'), 'utf8'));
    const t = createTranslator({ locale: 'en', messages, namespace: undefined });
    const translate = t as unknown as (key: string) => string;
    for (const key of keys) {
      const text = translate(key);
      expect(text.length, `${locale} ${key}`).toBeGreaterThan(0);
      expect(text, `${locale} ${key}`).not.toContain('--');
    }
  });
});
