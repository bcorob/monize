import { test, expect } from '../fixtures';
import { loginUser } from '../helpers/auth';
import { gotoStable } from '../helpers/nav';
import {
  createApiClient,
  loginViaApi,
  rawApiRequest,
  uniqueId,
} from '../helpers/api';
import {
  createAccount,
  createDelegate,
  grantDelegateAccount,
} from '../helpers/factories';

// Shared access / delegation. An owner can grant another person scoped access
// to their account. The owner-side management UI lives at
// /settings/shared-access; a delegate signs in with their own credentials and
// switches into the owner's context to see only what was granted.
test.describe('Delegation (shared access)', () => {
  test('owner adds and removes a delegate', async ({ authedPage: page }) => {
    const email = `e2e-del-${uniqueId()}@test.example.com`;

    await page.goto('/settings/shared-access');
    await page.getByRole('button', { name: 'Add delegate' }).first().click();

    await page.getByPlaceholder('Delegate email').fill(email);
    // New email + no invite -> the owner sets a password directly.
    await page.getByPlaceholder('Set a password').fill('E2eTestPass123!');
    await page.getByRole('button', { name: 'Add delegate' }).last().click();

    await expect(page.getByText(email)).toBeVisible();

    await page.getByRole('button', { name: 'Remove', exact: true }).click();
    await page
      .getByRole('dialog')
      .getByRole('button', { name: 'Remove', exact: true })
      .click();

    await expect(page.getByText(email)).toHaveCount(0);
  });

  test('a delegate sees an account shared with them', async ({
    authedPage: page,
    api,
    browser,
  }) => {
    const owner = await api.get<{ id: string }>('/auth/profile');
    const account = await createAccount(api, { name: `Shared ${uniqueId()}` });
    const email = `e2e-del-${uniqueId()}@test.example.com`;
    const password = 'E2eTestPass123!';
    const delegate = await createDelegate(api, { email, password });
    await grantDelegateAccount(api, delegate.id, account.id);

    // The delegate signs in from their own browser context.
    const delegateContext = await browser.newContext();
    try {
      const delegatePage = await delegateContext.newPage();
      await loginUser(delegatePage, email, password);

      // Switch into the owner's context explicitly so the server-side context
      // is deterministic. The DelegationBanner in the browser page also
      // auto-switches this single-owner delegate, and that path ends in a
      // window.location.reload() which can abort a concurrent goto with
      // net::ERR_ABORTED -- gotoStable retries past that transient reload.
      // GET /accounts is @AllowDelegate and returns granted accounts.
      const delegateApi = createApiClient(delegatePage.request);
      await delegateApi.post('/auth/switch-context', { targetUserId: owner.id });

      await gotoStable(delegatePage, '/accounts');
      await expect(
        delegatePage.locator('tr', { hasText: account.name }),
      ).toBeVisible({ timeout: 15000 });
    } finally {
      await delegateContext.close();
    }
  });

  // The full cross-owner transfer journey: A shares with B (create+edit) ->
  // B transfers from their OWN account into A's shared account, from their
  // own context -> balances verified on both sides -> A revokes -> B sees the
  // masked counterpart and the frozen lock -> A re-shares -> B edits the
  // amount and both legs update (the stateless reconnect).
  test('cross-owner transfer survives unshare and reconnects on reshare', async ({
    api,
    browser,
  }) => {
    const ownerAccount = await createAccount(api, {
      name: `XO Shared ${uniqueId()}`,
      openingBalance: 5000,
    });
    const email = `e2e-xo-${uniqueId()}@test.example.com`;
    const password = 'E2eTestPass123!';
    const delegate = await createDelegate(api, { email, password });
    await grantDelegateAccount(api, delegate.id, ownerAccount.id, {
      canCreate: true,
      canEdit: true,
    });

    // B works API-only from a fresh context, staying in their OWN context
    // (no page load, so the delegation banner never auto-switches them).
    const delegateContext = await browser.newContext();
    try {
      await loginViaApi(delegateContext.request, email, password);
      const delegateApi = createApiClient(delegateContext.request);

      const delegateAccount = await delegateApi.post<{ id: string }>(
        '/accounts',
        {
          name: `XO Own ${uniqueId()}`,
          accountType: 'CHEQUING',
          currencyCode: 'USD',
          openingBalance: 2000,
        },
      );

      // B -> A from B's own context.
      const transfer = await delegateApi.post<{
        fromTransaction: { id: string };
        toTransaction: { id: string };
      }>('/transactions/transfer', {
        fromAccountId: delegateAccount.id,
        toAccountId: ownerAccount.id,
        transactionDate: '2026-01-15',
        amount: 500,
        fromCurrencyCode: 'USD',
      });

      // Both sides see their balance move.
      const ownAfter = await delegateApi.get<{ currentBalance: number }>(
        `/accounts/${delegateAccount.id}`,
      );
      expect(Number(ownAfter.currentBalance)).toBe(1500);
      const sharedAfter = await api.get<{ currentBalance: number }>(
        `/accounts/${ownerAccount.id}`,
      );
      expect(Number(sharedAfter.currentBalance)).toBe(5500);

      // While connected, B can read the counterpart unmasked.
      const connectedView = await delegateApi.get<{
        linkedTransaction: { account: { name: string } };
      }>(`/transactions/${transfer.fromTransaction.id}`);
      expect(connectedView.linkedTransaction.account.name).toContain(
        'XO Shared',
      );

      // A revokes. B keeps their leg but the counterpart freezes.
      await api.delete(`/delegation/delegates/${delegate.id}`);

      const frozenView = await delegateApi.get<{
        payeeName: string;
        linkedTransaction: { account: { name: string } } | null;
      }>(`/transactions/${transfer.fromTransaction.id}`);
      expect(frozenView.linkedTransaction?.account?.name).toBe(
        'Hidden account',
      );
      // The stored payee is blank (issue #1214): the display resolves
      // "Transfer to <account>" from the masked linked account above, so the
      // payee field has nothing to leak.
      expect(frozenView.payeeName).toBeNull();

      // Structural edits are locked...
      const locked = await rawApiRequest(
        delegateContext.request,
        'PATCH',
        `/transactions/${transfer.fromTransaction.id}/transfer`,
        { amount: 900 },
      );
      expect(locked.status()).toBe(400);
      // ...but presentational own-leg edits still work.
      await delegateApi.patch(
        `/transactions/${transfer.fromTransaction.id}/transfer`,
        { description: 'still mine' },
      );

      // A re-shares (same email reactivates the delegation) with edit.
      const reshared = await createDelegate(api, { email, password });
      await grantDelegateAccount(api, reshared.id, ownerAccount.id, {
        canCreate: true,
        canEdit: true,
      });

      // The stateless reconnect: a full cross-leg edit works again.
      await delegateApi.patch(
        `/transactions/${transfer.fromTransaction.id}/transfer`,
        { amount: 700 },
      );

      const ownFinal = await delegateApi.get<{ currentBalance: number }>(
        `/accounts/${delegateAccount.id}`,
      );
      expect(Number(ownFinal.currentBalance)).toBe(1300);
      const sharedFinal = await api.get<{ currentBalance: number }>(
        `/accounts/${ownerAccount.id}`,
      );
      expect(Number(sharedFinal.currentBalance)).toBe(5700);

      // A's own leg mirrored the new amount.
      const ownerLeg = await api.get<{ amount: number }>(
        `/transactions/${transfer.toTransaction.id}`,
      );
      expect(Number(ownerLeg.amount)).toBe(700);
    } finally {
      await delegateContext.close();
    }
  });
});
