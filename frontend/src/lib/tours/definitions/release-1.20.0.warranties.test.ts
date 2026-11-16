import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createTranslator } from 'use-intl';
import {
  RELEASE_1_20_MINOR,
  RELEASE_1_20_TOURS,
  RELEASE_1_20_WARRANTIES_TOUR,
} from './release-1.20.0';
import { TOUR_ANCHORS } from '../anchors';
import { getReleaseTours, getTourById } from '../registry';
import { isTourOfferable } from '../requirements';
import { isStepReachable } from '../navigation';
import type { TourAnchorId } from '../anchors';

const tour = RELEASE_1_20_WARRANTIES_TOUR;
const ANCHOR_VALUES = new Set<TourAnchorId>(Object.values(TOUR_ANCHORS));
const step = (id: string) => tour.steps.find((s) => s.id === id);
const FORM_STEPS = ['newTransaction', 'warrantiesLine', 'closeForm'];

describe('warranties release tour', () => {
  it('is a 1.20 release tour registered under a stable id', () => {
    expect(RELEASE_1_20_MINOR).toBe('1.20');
    expect(tour.id).toBe('release-1.20.0/warranties');
    expect(tour.version).toBe('1.20');
    expect(tour.area).toBe('transactions');
    expect(tour.i18nPrefix).toBe('release.v1_20_0.warranties');
    expect(RELEASE_1_20_TOURS).toContain(tour);
    expect(getTourById(tour.id)).toBe(tour);
    expect(getReleaseTours('1.20.3').map((t) => t.id)).toContain(tour.id);
    expect(getReleaseTours('1.19.0').map((t) => t.id)).not.toContain(tour.id);
  });

  it('walks the page, the three ways to add one, then where they show up', () => {
    expect(tour.steps.map((s) => s.id)).toEqual([
      'welcome',
      'warrantiesLink',
      'overview',
      'addWarranty',
      'importCsv',
      'inRegister',
      'newTransaction',
      'warrantiesLine',
      'closeForm',
      'dashboardWidget',
      'reminders',
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

  it('points inside the open Tools menu, desktop only', () => {
    const link = step('warrantiesLink');
    expect(link?.route).toBe('/dashboard');
    expect(link?.anchorId).toBe(TOUR_ANCHORS.navWarranties);
    expect(link?.openToolsMenu).toBe(true);
    // The phone drawer carries no anchors, as in the other Tools steps.
    expect(link?.skipOnMobile).toBe(true);
  });

  it('anchors the page steps on the summary cards and the toolbar buttons', () => {
    expect(step('overview')?.route).toBe('/warranties');
    expect(step('overview')?.anchorId).toBe(TOUR_ANCHORS.warrantiesSummary);
    expect(step('addWarranty')?.route).toBe('/warranties');
    expect(step('addWarranty')?.anchorId).toBe(TOUR_ANCHORS.warrantiesAddButton);
    expect(step('importCsv')?.route).toBe('/warranties');
    expect(step('importCsv')?.anchorId).toBe(TOUR_ANCHORS.warrantiesImportButton);
  });

  it('describes the register without anchoring a row', () => {
    // An anchor on a row repeats on every row; the coach mark leaves the
    // register in view instead.
    const s = step('inRegister');
    expect(s?.route).toBe('/transactions');
    expect(s?.anchorId).toBeNull();
    expect(s?.unobtrusive).toBe(true);
    expect(s?.advance).toBeUndefined();
  });

  it('opens the New Transaction form, shows its Warranties line, and closes it', () => {
    expect(step('newTransaction')?.anchorId).toBe(TOUR_ANCHORS.transactionsNewButton);
    expect(step('newTransaction')?.advance).toEqual({
      type: 'appear',
      anchorId: TOUR_ANCHORS.transactionForm,
    });
    expect(step('warrantiesLine')?.anchorId).toBe(TOUR_ANCHORS.transactionWarrantiesLine);
    expect(step('closeForm')?.anchorId).toBe(TOUR_ANCHORS.transactionFormActions);
    expect(step('closeForm')?.advance).toEqual({
      type: 'disappear',
      anchorId: TOUR_ANCHORS.transactionForm,
    });
    for (const id of FORM_STEPS) {
      expect(step(id)?.route).toBe('/transactions');
      // No account, no form to walk.
      expect(step(id)?.requires).toBe('transactionEntry');
    }
    // Back never lands on an anchor that closed with the form.
    expect(step('warrantiesLine')?.skipOnBack).toBe(true);
    expect(step('closeForm')?.skipOnBack).toBe(true);
  });

  it('stands in for the Warranties line a joint account hides, without a long blank wait', () => {
    const s = step('warrantiesLine');
    expect(s?.fallbackWhenMissing).toBe(true);
    expect(s?.anchorTimeoutMs).toBeLessThanOrEqual(3000);
    // Passive, so the line's own Add warranty stays covered: pressing it would
    // save the transaction and leave for the Warranties page mid-tour.
    expect(s?.advance).toBeUndefined();
    expect(s?.allowInteraction).toBeUndefined();
    for (const other of tour.steps) {
      if (other.id !== 'warrantiesLine') expect(other.fallbackWhenMissing).toBeUndefined();
    }
  });

  it('ends on the dashboard widget and the reminder bell', () => {
    expect(step('dashboardWidget')?.route).toBe('/dashboard');
    expect(step('dashboardWidget')?.anchorId).toBe(TOUR_ANCHORS.dashboardCustomize);
    expect(step('reminders')?.route).toBe('/dashboard');
    expect(step('reminders')?.anchorId).toBe(TOUR_ANCHORS.notificationBell);
  });

  it('only routes where the engine can navigate', () => {
    for (const s of tour.steps) {
      expect(s.routeMatch).toBeUndefined();
      expect(isStepReachable(s, '/dashboard')).toBe(true);
    }
  });

  it('is owner-only: a delegate sees no Add, no Import and no Warranties line', () => {
    expect(tour.requiresData).toBe('ownerView');
    const base = { transactionEntry: true, accountsExist: true, securitiesExist: true };
    expect(isTourOfferable(tour, { ...base, ownerView: true })).toBe(true);
    expect(isTourOfferable(tour, { ...base, ownerView: false })).toBe(false);
  });
});

describe('warranties tour copy', () => {
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
    expect(translate(`${tour.i18nPrefix}.title`).length).toBeGreaterThan(0);
    for (const s of tour.steps) {
      const base = `${tour.i18nPrefix}.steps.${s.id}`;
      expect(translate(`${base}.title`).length).toBeGreaterThan(0);
      expect(translate(`${base}.body`).length).toBeGreaterThan(0);
    }
    expect(
      translate(`${tour.i18nPrefix}.steps.warrantiesLine.fallbackBody`).length,
    ).toBeGreaterThan(0);
  });

  it('names the search token and the reminder days literally', () => {
    const messages = JSON.parse(
      readFileSync(join(messagesDir, 'en', 'tours.json'), 'utf8'),
    );
    const t = createTranslator({ locale: 'en', messages, namespace: undefined });
    const translate = t as unknown as (key: string) => string;
    const steps = `${tour.i18nPrefix}.steps`;
    expect(translate(`${steps}.inRegister.body`)).toContain('**has:warranty**');
    // The Copy menu offers no warranty action, so the tour must not send the
    // reader there.
    expect(translate(`${steps}.inRegister.body`)).not.toMatch(/add warranty|view warranties|\*\*Copy\*\*/i);
    expect(translate(`${steps}.reminders.body`)).toMatch(/30 days and 7 days/);
    for (const s of tour.steps) {
      expect(translate(`${steps}.${s.id}.body`)).not.toContain('--');
    }
  });
});
