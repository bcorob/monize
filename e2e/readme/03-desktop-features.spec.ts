import { test, expect, type BrowserContext, type Locator, type Page } from '@playwright/test';
import { apiFor, open, openSession, scrollUnderHeader, shoot, waitForReady } from './session';
import { loadIds, type Ids } from './ids';
import { DESKTOP_CONTEXT, showcaseMonth, todayYmd } from './settings';
import { firstOfMonth } from './seed-finance';

// Desktop pictures that need a click or two first: a calendar on another month,
// a report with its breakdown switched on, a dialog, a colour palette.

let context: BrowserContext;
let page: Page;
let ids: Ids;

test.beforeAll(async ({ browser }) => {
  context = await openSession(browser, DESKTOP_CONTEXT);
  page = await context.newPage();
  await page.goto('/dashboard');
  ids = await loadIds(apiFor(page));
});

test.afterAll(async () => {
  await context.close();
});

const chartDrawn = (p: Page) => expect(p.locator('.recharts-surface').first()).toBeVisible();

/** Scroll `locator` to just under the app header, with the header showing. */
const scrollTo = (locator: Locator, gap = 16) => scrollUnderHeader(page, locator, gap);

test('investments, calendar view', async () => {
  await open(page, '/investments');
  // Only the accounts held in the reporting currency: a calendar that must add
  // in another currency withholds its totals where no exchange rate is stored.
  // The list closes again if the page re-renders while the accounts finish
  // loading, so the whole open-and-tick step is retried as one unit.
  const rrsp = page.getByRole('checkbox', { name: 'RRSP - Retirement' });
  const tfsa = page.getByRole('checkbox', { name: 'TFSA - Tax Free' });
  await expect(async () => {
    if ((await rrsp.count()) === 0) {
      await page.getByText('All Investment Accounts').first().click();
    }
    await rrsp.check({ timeout: 3_000 });
    await tfsa.check({ timeout: 3_000 });
  }).toPass({ timeout: 20_000 });
  await expect(rrsp).toBeChecked();
  await expect(tfsa).toBeChecked();
  await page.keyboard.press('Escape');

  // The register reloads for the new selection and can drop the view choice
  // with it, so the account filter has to be applied (the summary names the
  // selection) before the view is switched, and the switch is retried until
  // the calendar is really on screen.
  await expect(page.getByRole('heading', { name: /^Portfolio Summary \(/ })).toBeVisible();
  await waitForReady(page);
  const grid = page.getByRole('grid');
  await expect(async () => {
    const calendar = page.getByRole('button', { name: 'Calendar', exact: true });
    if ((await calendar.getAttribute('aria-pressed')) !== 'true') {
      await calendar.click();
    }
    await expect(grid).toBeVisible({ timeout: 3_000 });
  }).toPass({ timeout: 20_000 });
  for (let i = 0; i < showcaseMonth().monthsBack; i++) {
    await page.getByRole('button', { name: 'Previous month' }).click();
  }
  await page.getByRole('button', { name: 'Values', exact: true }).click();
  await page.getByRole('button', { name: 'Daily change', exact: true }).click();
  await expect(grid).toContainText('%');
  await waitForReady(page);
  await scrollTo(page.getByRole('group', { name: 'Layers' }));
  await shoot(page, 'investments-calendar');
});

test('the budget wizard, on the step with the suggested amounts', async () => {
  await open(page, '/budgets');
  await page.getByRole('button', { name: /New Budget/ }).first().click();
  await page.getByRole('button', { name: '12 months' }).click();
  await page.getByRole('button', { name: 'Analyze My Spending' }).click();
  await expect(page.getByRole('heading', { name: 'Review Categories' })).toBeVisible();
  await expect(page.getByText('Food: Groceries')).toBeVisible();
  await waitForReady(page);
  await page.evaluate(() => window.scrollTo(0, 0));
  await shoot(page, 'budget-wizard');

  // Leave without saving: back to the first step, then Cancel.
  await page.getByRole('button', { name: 'Back' }).click();
  await page.getByRole('button', { name: 'Cancel' }).click();
  await expect(page.getByText('Budget', { exact: false }).first()).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Create Budget' })).toHaveCount(0);
});

test('a rule in the editor', async () => {
  await open(page, '/rules');
  await page
    .getByRole('row', { name: /Dinners out over \$100/ })
    .getByText('Edit', { exact: true })
    .click();
  await expect(page.getByRole('heading', { name: 'Edit rule' })).toBeVisible();
  await expect(page.getByLabel('Name')).toHaveValue('Dinners out over $100');
  await waitForReady(page);
  await scrollTo(page.getByRole('heading', { name: 'If', exact: true }), 40);
  await shoot(page, 'rule-editor');
});

test('income vs expenses, broken down by tag key', async () => {
  await open(page, '/reports/income-vs-expenses');
  await page.getByRole('combobox').selectOption({ label: 'project' });
  await chartDrawn(page);
  await waitForReady(page);
  const breakdown = page.getByRole('heading', { name: /Break down by tag key/ });
  await expect(breakdown).toBeVisible();
  await scrollTo(breakdown, 40);
  await shoot(page, 'report-tag-breakdown');
});

test('foreign currency fees', async () => {
  await open(page, '/reports/foreign-currency-fees');
  await expect(page.getByText('Hotel Avenida Palace').first()).toBeVisible();
  await shoot(page, 'report-foreign-fees');
});

test('net worth, from the first full month', async () => {
  await open(page, '/reports/net-worth');
  await page.getByRole('button', { name: 'Custom' }).click();
  await page.locator('#input-start-date').fill(firstOfMonth(todayYmd(), -11));
  await page.locator('#input-end-date').fill(todayYmd());
  await page.getByRole('button', { name: 'Recalculate' }).click();
  await chartDrawn(page);
  await waitForReady(page);
  await shoot(page, 'net-worth');
});

test('the credit card, with its foreign fee', async () => {
  await open(page, `/accounts/${ids.visa}`);
  await chartDrawn(page);
  await shoot(page, 'account-credit-card');
});

test('Monte Carlo simulation', async () => {
  await open(page, '/reports/monte-carlo-simulation');
  await page.getByText('Retire at 60, balanced portfolio').first().click();
  await page.getByRole('button', { name: 'Run simulation' }).click();
  await expect(page.getByRole('heading', { name: 'Performance Summary' })).toBeVisible();
  await chartDrawn(page);
  await waitForReady(page);
  await scrollTo(page.getByRole('button', { name: 'Run again' }), 40);
  await shoot(page, 'monte-carlo');
});

test('a receipt attached to a transaction', async () => {
  await open(page, '/transactions');
  await page.getByPlaceholder(/Search payee/).fill('Avenida');
  const row = page.getByRole('row', { name: /Hotel Avenida Palace/ });
  await expect(row).toBeVisible();
  await row.getByRole('cell').nth(2).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Preview avenida-palace-invoice.png' }).click();
  const preview = page.getByRole('dialog', { name: 'avenida-palace-invoice.png' });
  await expect(preview.getByRole('img', { name: 'avenida-palace-invoice.png' })).toBeVisible();
  await shoot(page, 'attachment-preview');
});

test('notification settings', async () => {
  await open(page, '/settings');
  await page
    .getByLabel('Settings sections')
    .getByRole('button', { name: 'Notifications', exact: true })
    .click();
  const heading = page.getByRole('heading', { name: 'Notifications', exact: true }).first();
  await expect(heading).toBeVisible();
  await scrollTo(heading, 40);
  await shoot(page, 'notifications-settings');
});

test('the MS Money palette', async () => {
  const api = apiFor(page);
  await api.patch('/users/preferences', { colorTheme: 'msmoney' });
  try {
    await open(page, '/dashboard');
    await page.reload();
    await waitForReady(page);
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'msmoney');
    await expect(page.getByText('Car Insurance').first()).toBeVisible();
    await chartDrawn(page);
    await shoot(page, 'theme-msmoney');
  } finally {
    await api.patch('/users/preferences', { colorTheme: 'default' });
    await page.reload();
    await expect(page.locator('html')).not.toHaveAttribute('data-theme', /.+/);
  }
});
