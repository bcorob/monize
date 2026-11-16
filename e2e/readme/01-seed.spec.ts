import { test, expect } from '@playwright/test';
import { apiFor, openSession } from './session';
import { loadLookups, type Named } from './seed-lookup';
import {
  seedCardStatement,
  seedForeignTransaction,
  seedLoans,
  seedMortgageHistory,
  seedPayeeContact,
  seedSchedules,
} from './seed-finance';
import { seedAllocations, seedFavourites, seedMonteCarlo, seedVehicleValue } from './seed-extras';
import { attachTags, seedRules, seedTags } from './seed-tags-rules';
import { seedBudget, seedDayNotes, seedPreferences } from './seed-budget-notes';
import { seedReceipt } from './seed-attachment';
import { currentMonth, monthName, showcaseMonth } from './settings';

// Fills the gaps in the built-in demo data -- tags, rules, a budget, loans and
// the rest -- through the API, so the pictures that follow have something to
// show. Every step looks a record up by name and creates it only when it is
// absent: running this twice leaves the data exactly as the first run did.

test.describe.configure({ mode: 'serial' });

test('seeds the showcase data', async ({ browser }) => {
  const context = await openSession(browser);
  const page = await context.newPage();
  await page.goto('/dashboard');
  const api = apiFor(page);

  const preferences = await test.step('dark mode and first-run prompts off', () =>
    seedPreferences(api));
  const lookups = await loadLookups(api);

  const tags = await test.step('tags', () => seedTags(api));
  const hotelId = await test.step('a euro purchase on the Visa', () =>
    seedForeignTransaction(api, lookups, tags));
  await test.step('a statement cycle on the Visa', () => seedCardStatement(api, lookups));
  await test.step('a receipt on it', () => seedReceipt(page, browser, hotelId));
  await test.step('tags on transactions', () => attachTags(api, lookups, tags));
  await test.step('rules', () => seedRules(api, lookups, tags));
  await test.step('payee contact details', () => seedPayeeContact(api, lookups));
  await test.step('mortgage rate history and scenarios', () => seedMortgageHistory(api, lookups));
  await test.step('car loan, line of credit and the Vehicle link', () => seedLoans(api));
  await test.step('favourite accounts', () => seedFavourites(api, lookups));
  await test.step('schedules', () => seedSchedules(api, lookups));
  await test.step('fund allocations', () => seedAllocations(api, lookups));
  await test.step('vehicle value adjustments', () => seedVehicleValue(api, lookups));
  await test.step('Monte Carlo scenarios', () => seedMonteCarlo(api));

  // A budget always reports the calendar month it is opened in; the calendar
  // and its notes use the month that already holds transactions.
  const thisMonth = currentMonth();
  await test.step('budget', () => seedBudget(api, thisMonth, preferences.defaultCurrency ?? 'CAD'));
  await test.step('calendar day notes', () => seedDayNotes(api, showcaseMonth()));

  // The balance snapshots are derived from the ledger and the exchange rates;
  // recalculating after the seed makes them use both.
  await test.step('net worth snapshots', () => api.post('/net-worth/recalculate'));

  // Read it back: what is on the server is what the pictures will show.
  const names = async (path: string) => (await api.get<Named[]>(path)).map((r) => r.name);
  expect(await names('/tags')).toEqual(
    expect.arrayContaining(['trip:Lisbon', 'project:Kitchen', 'Date night', 'Coffee run', 'Subscription', 'Home office']),
  );
  expect(await names('/transaction-rules')).toEqual(
    expect.arrayContaining(['Coffee runs', 'Streaming subscriptions', 'Dinners out over $100', 'Home office bills', 'Costco receipts', 'Kitchen renovation']),
  );
  expect(await names('/budgets')).toContain(`${monthName(thisMonth.month)} ${thisMonth.year} Budget`);
  expect(await names('/accounts')).toEqual(
    expect.arrayContaining(['Car Loan', 'Home Equity Line of Credit']),
  );

  await context.close();
});
