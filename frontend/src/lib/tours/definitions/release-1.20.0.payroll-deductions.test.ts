import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createTranslator } from 'use-intl';
import {
  RELEASE_1_20_PAYROLL_DEDUCTIONS_TOUR,
  RELEASE_1_20_TOURS,
} from './release-1.20.0';
import { TOUR_ANCHORS } from '../anchors';
import { getReleaseTours, getTourById } from '../registry';
import { isTourOfferable } from '../requirements';
import { isStepReachable } from '../navigation';
import type { TourAnchorId } from '../anchors';

const tour = RELEASE_1_20_PAYROLL_DEDUCTIONS_TOUR;
const ANCHOR_VALUES = new Set<TourAnchorId>(Object.values(TOUR_ANCHORS));
const step = (id: string) => tour.steps.find((s) => s.id === id);
const PAGE = '/taxes/payroll-deductions';

describe('payroll deductions release tour', () => {
  it('is a 1.20 release tour registered under a stable id', () => {
    expect(tour.id).toBe('release-1.20.0/payroll-deductions');
    expect(tour.version).toBe('1.20');
    expect(tour.i18nPrefix).toBe('release.v1_20_0.payrollDeductions');
    expect(RELEASE_1_20_TOURS).toContain(tour);
    expect(getTourById(tour.id)).toBe(tour);
    expect(getReleaseTours('1.20.0').map((t) => t.id)).toContain(tour.id);
    expect(getReleaseTours('1.19.0').map((t) => t.id)).not.toContain(tour.id);
  });

  it('names the payroll bill requirement before it goes looking for the tool', () => {
    expect(tour.steps.map((s) => s.id)).toEqual([
      'welcome',
      'payrollBill',
      'taxesLink',
      'taxesCard',
      'newRule',
      'rulesList',
      'periodTables',
      'forecast',
      'reminders',
    ]);
    expect(step('payrollBill')?.route).toBe('/bills');
    expect(step('payrollBill')?.anchorId).toBe(TOUR_ANCHORS.billsNewButton);
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
    expect(welcome.route).toBeUndefined();
    expect(welcome.anchorId).toBeNull();
  });

  it('points inside the open Tools menu, desktop only', () => {
    const link = step('taxesLink');
    expect(link?.anchorId).toBe(TOUR_ANCHORS.navTaxes);
    expect(link?.openToolsMenu).toBe(true);
    expect(link?.skipOnMobile).toBe(true);
  });

  it('walks the Taxes card and the page through anchors every page state renders', () => {
    expect(step('taxesCard')?.route).toBe('/taxes');
    expect(step('taxesCard')?.anchorId).toBe(TOUR_ANCHORS.taxesPayrollDeductions);
    expect(step('newRule')?.route).toBe(PAGE);
    expect(step('newRule')?.anchorId).toBe(TOUR_ANCHORS.payrollNewRuleButton);
    expect(step('rulesList')?.route).toBe(PAGE);
    expect(step('rulesList')?.anchorId).toBe(TOUR_ANCHORS.payrollRulesList);
    // The two tables' buttons render only once a rule exists.
    expect(step('periodTables')?.route).toBe(PAGE);
    expect(step('periodTables')?.anchorId).toBeNull();
    expect(step('periodTables')?.unobtrusive).toBe(true);
  });

  it('ends on the forecast and the reset reminder', () => {
    expect(step('forecast')?.route).toBe('/bills');
    expect(step('forecast')?.anchorId).toBe(TOUR_ANCHORS.billsCashFlowForecast);
    expect(step('reminders')?.route).toBe('/dashboard');
    expect(step('reminders')?.anchorId).toBe(TOUR_ANCHORS.notificationBell);
  });

  it('is passive throughout and only routes where the engine can navigate', () => {
    for (const s of tour.steps) {
      expect(s.advance).toBeUndefined();
      expect(s.requires).toBeUndefined();
      expect(s.routeMatch).toBeUndefined();
      expect(isStepReachable(s, '/dashboard')).toBe(true);
    }
  });

  it('is owner-only: Taxes and every payroll deductions route refuse a delegate', () => {
    expect(tour.requiresData).toBe('ownerView');
    const base = { transactionEntry: true, accountsExist: true, securitiesExist: true };
    expect(isTourOfferable(tour, { ...base, ownerView: true })).toBe(true);
    expect(isTourOfferable(tour, { ...base, ownerView: false })).toBe(false);
  });
});

describe('payroll deductions tour copy', () => {
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

  const translatorFor = (locale: string) => {
    const messages = JSON.parse(
      readFileSync(join(messagesDir, locale, 'tours.json'), 'utf8'),
    );
    const t = createTranslator({ locale: 'en', messages, namespace: undefined });
    return t as unknown as (key: string) => string;
  };

  it.each(locales)('formats every step in "%s" without an ICU error', (locale) => {
    const translate = translatorFor(locale);
    expect(translate(`${tour.i18nPrefix}.title`).length).toBeGreaterThan(0);
    for (const s of tour.steps) {
      const base = `${tour.i18nPrefix}.steps.${s.id}`;
      expect(translate(`${base}.title`).length).toBeGreaterThan(0);
      expect(translate(`${base}.body`).length).toBeGreaterThan(0);
    }
  });

  it('tells the reader up front that a payroll scheduled bill is required', () => {
    const translate = translatorFor('en');
    const steps = `${tour.i18nPrefix}.steps`;
    expect(translate(`${steps}.welcome.body`)).toMatch(/payroll scheduled bill/);
    expect(translate(`${steps}.payrollBill.body`)).toContain('**+ New Schedule**');
    // A deduction already at this year's maximum still needs its line, or no
    // rule can cap it and it never starts again after the reset.
    expect(translate(`${steps}.payrollBill.body`)).toMatch(/zero-value expense/);
    for (const s of tour.steps) {
      expect(translate(`${steps}.${s.id}.body`)).not.toContain('--');
    }
  });
});
