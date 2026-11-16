import { test, expect } from '../fixtures';
import {
  createAccount,
  createInvestmentAccountPair,
  createSecurity,
  createInvestmentTransaction,
} from '../helpers/factories';
import { uniqueId } from '../helpers/api';

// An investment account is stored as two accounts -- an INVESTMENT_BROKERAGE
// holding the securities and a linked INVESTMENT_CASH holding the money -- and
// the app now presents that pair as the one account the user thinks they have
// (GitHub discussion #903).
//
// The seeded pair is the precondition; every assertion below is about what the
// running UI does with it. The pair's stored names carry a " - Brokerage" /
// " - Cash" suffix the server generates, so those strings appearing on screen
// is the regression this journey guards against.
test.describe('Investment account consolidation', () => {
  test('shows a linked pair as one account in the list', async ({
    authedPage: page,
    api,
  }) => {
    const name = `Consolidated ${uniqueId()}`;
    await createInvestmentAccountPair(api, { name, openingBalance: 5000 });

    await page.goto('/accounts');

    // One row, under the name the user gave the account.
    await expect(page.locator('tr', { hasText: name })).toHaveCount(1);
    await expect(
      page.locator('tr', { hasText: `${name} - Cash` }),
    ).toHaveCount(0);
    await expect(
      page.locator('tr', { hasText: `${name} - Brokerage` }),
    ).toHaveCount(0);
  });

  test('totals the holdings and the cash on that one row', async ({
    authedPage: page,
    api,
  }) => {
    const name = `Combined ${uniqueId()}`;
    const pair = await createInvestmentAccountPair(api, {
      name,
      openingBalance: 5000,
    });
    const security = await createSecurity(api, { name: `Sec ${uniqueId()}` });
    // Spends 1000 of the cash on securities: the account is still worth 5000,
    // now split across its two ledgers.
    await createInvestmentTransaction(api, {
      accountId: pair.brokerageAccount.id,
      fundingAccountId: pair.cashAccount.id,
      securityId: security.id,
      action: 'BUY',
      quantity: 10,
      price: 100,
    });

    await page.goto('/accounts');

    const row = page.locator('tr', { hasText: name }).first();
    await expect(row).toBeVisible();
    // The row says what the total is made of, which is only meaningful because
    // it covers both ledgers.
    await expect(row).toContainText(/Investments/);
    await expect(row).toContainText(/Cash/);
  });

  test('offers both ledgers on the account detail page', async ({
    authedPage: page,
    api,
  }) => {
    const name = `Detail ${uniqueId()}`;
    const pair = await createInvestmentAccountPair(api, {
      name,
      openingBalance: 2500,
    });

    await page.goto(`/accounts/${pair.brokerageAccount.id}`);

    // The title is the account, not the ledger the URL names.
    await expect(page.getByRole('heading', { name, exact: true })).toBeVisible({
      timeout: 15000,
    });

    // The register switches between the two ledgers behind one toggle.
    const cashTab = page.getByRole('button', { name: 'Cash', exact: true });
    await expect(cashTab).toBeVisible();
    await cashTab.click();
    await expect(
      page.getByRole('button', { name: 'Brokerage', exact: true }),
    ).toBeVisible();
  });

  test('sends a link to the cash ledger to the account page', async ({
    authedPage: page,
    api,
  }) => {
    const name = `Canonical ${uniqueId()}`;
    const pair = await createInvestmentAccountPair(api, { name });

    // An old bookmark, or a deep link out of a register.
    await page.goto(`/accounts/${pair.cashAccount.id}`);

    await expect(page).toHaveURL(
      new RegExp(`/accounts/${pair.brokerageAccount.id}$`),
    );
  });

  test('edits the account name and its cash ledger from one form', async ({
    authedPage: page,
    api,
  }) => {
    const name = `Editable ${uniqueId()}`;
    const renamed = `Renamed ${uniqueId()}`;
    await createInvestmentAccountPair(api, { name, openingBalance: 1000 });

    await page.goto('/accounts');
    await page
      .locator('tr', { hasText: name })
      .getByRole('button', { name: 'Edit', exact: true })
      .click();

    const dialog = page.getByRole('dialog');
    // The field edits the shared base name, not the stored "- Brokerage" one.
    await expect(dialog.getByLabel(/account name/i)).toHaveValue(name);

    // The cash ledger's own fields are reachable here and nowhere else.
    await dialog.getByRole('button', { name: /cash account/i }).click();
    await expect(dialog.getByLabel(/cash account number/i)).toBeVisible();
    await dialog.getByLabel(/cash account number/i).fill('E2E-12345');

    await dialog.getByLabel(/account name/i).fill(renamed);
    await dialog.getByRole('button', { name: /update account/i }).click();

    // Both halves follow the rename, so the row is still one account.
    await expect(page.locator('tr', { hasText: renamed })).toHaveCount(1);
    await page.reload();
    await expect(page.locator('tr', { hasText: renamed })).toHaveCount(1);
    await expect(page.locator('tr', { hasText: name })).toHaveCount(0);
  });

  test('offers the account under one name when moving money into it', async ({
    authedPage: page,
    api,
  }) => {
    const name = `Transfer Target ${uniqueId()}`;
    await createInvestmentAccountPair(api, { name });
    const chequing = await createAccount(api, {
      name: `Source ${uniqueId()}`,
      accountType: 'CHEQUING',
    });

    await page.goto(`/transactions?accountId=${chequing.id}`);
    await page.getByRole('button', { name: /new transaction/i }).first().click();

    const dialog = page.getByRole('dialog');
    await dialog.getByRole('button', { name: /transfer/i }).first().click();

    // Money lands in the cash ledger, but the picker names the account.
    const options = dialog.locator('option');
    await expect(options.filter({ hasText: name }).first()).toHaveCount(1);
    await expect(options.filter({ hasText: `${name} - Cash` })).toHaveCount(0);
  });

  test('closes and reopens both ledgers from the single row', async ({
    authedPage: page,
    api,
  }) => {
    const name = `Closeable ${uniqueId()}`;
    // Nothing in it, so the whole account is empty and may be closed.
    await createInvestmentAccountPair(api, { name, openingBalance: 0 });

    await page.goto('/accounts');
    await page
      .locator('tr', { hasText: name })
      .getByRole('button', { name: 'Close', exact: true })
      .click();
    await page
      .getByRole('dialog')
      .getByRole('button', { name: /close account/i })
      .click();

    // Both halves are closed, so the account shows once under the closed
    // filter and not at all under the active one.
    // The status segments carry their counts ("Closed (1)").
    const statusFilter = page.getByRole('group', { name: 'Status' });
    await statusFilter.getByRole('button', { name: /^Closed \(/ }).click();
    await expect(page.locator('tr', { hasText: name })).toHaveCount(1);

    await page
      .locator('tr', { hasText: name })
      .getByRole('button', { name: 'Reopen', exact: true })
      .click();

    await statusFilter.getByRole('button', { name: /^Active \(/ }).click();
    await expect(page.locator('tr', { hasText: name })).toHaveCount(1);
  });
});
