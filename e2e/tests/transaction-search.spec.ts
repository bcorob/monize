import { test, expect } from '../fixtures';
import { createAccount, createTransaction } from '../helpers/factories';
import { uniqueId } from '../helpers/api';

// The transaction search syntax (docs/specs/advanced-search.md): the
// cheque-number case from Discussion #1723, the line that says how a search
// was read, and the syntax help writing an example into the box. Seeded
// through the API; the account filter in the URL scopes the register to these
// rows, and also collapses the filter panel, so the panel is opened first.
test.describe('Transaction search syntax', () => {
  test('#10 finds cheque 10 and not 100 or 1010', async ({ authedPage: page, api }) => {
    const account = await createAccount(api, { name: `Cheques ${uniqueId()}` });
    const tag = uniqueId();
    for (const [ref, amount] of [
      ['10', -10.11],
      ['100', -100.22],
      ['1010', -1010.33],
    ] as const) {
      await createTransaction(api, {
        accountId: account.id,
        amount,
        payeeName: `Cheque ${ref} ${tag}`,
        referenceNumber: ref,
      });
    }

    await page.goto(`/transactions?accountIds=${account.id}`);
    const register = page.locator('table tbody');
    await expect(register.locator('tr', { hasText: `Cheque 1010 ${tag}` })).toBeVisible();

    await page.getByText('Filters', { exact: true }).click();
    const search = page.getByLabel('Search', { exact: true });
    await search.fill('#10');

    await expect(register.locator('tr', { hasText: `Cheque 10 ${tag}` })).toBeVisible();
    await expect(register.locator('tr', { hasText: `Cheque 100 ${tag}` })).toHaveCount(0);
    await expect(register.locator('tr', { hasText: `Cheque 1010 ${tag}` })).toHaveCount(0);
    await expect(page.getByRole('list', { name: 'Searching:' })).toHaveText(
      'Reference is “10”',
    );

    // The search survives a reload through the URL, and reads the same way.
    await page.reload();
    await expect(register.locator('tr', { hasText: `Cheque 10 ${tag}` })).toBeVisible();
    await expect(register.locator('tr', { hasText: `Cheque 100 ${tag}` })).toHaveCount(0);
  });

  test('the syntax help writes an example into the search box', async ({
    authedPage: page,
    api,
  }) => {
    const account = await createAccount(api, { name: `Help ${uniqueId()}` });
    const tag = uniqueId();
    for (const ref of ['10', '100', '210']) {
      await createTransaction(api, {
        accountId: account.id,
        payeeName: `Ref ${ref} ${tag}`,
        referenceNumber: ref,
      });
    }

    await page.goto(`/transactions?accountIds=${account.id}`);
    await page.getByText('Filters', { exact: true }).click();

    await page.getByRole('button', { name: 'Search syntax' }).click();
    const help = page.getByRole('dialog', { name: 'Search syntax' });
    await help.getByRole('button', { name: 'ref:10*', exact: true }).click();

    await expect(help).toHaveCount(0);
    await expect(page.getByLabel('Search', { exact: true })).toHaveValue('ref:10*');
    const register = page.locator('table tbody');
    await expect(register.locator('tr', { hasText: `Ref 10 ${tag}` })).toBeVisible();
    await expect(register.locator('tr', { hasText: `Ref 100 ${tag}` })).toBeVisible();
    await expect(register.locator('tr', { hasText: `Ref 210 ${tag}` })).toHaveCount(0);
  });
});
