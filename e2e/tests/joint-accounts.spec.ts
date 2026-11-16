import { test, expect } from '../fixtures';
import { loginUser } from '../helpers/auth';
import { E2E_DEFAULT_PASSWORD } from '../helpers/credentials';
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

// Joint accounts: an owner marks a shared account as joint, and it appears
// natively in the grantee's OWN account list (no context switch), with the
// grant's write permissions applying to the register. Revoking drops the
// account (and freezes any cross-owner transfer legs); re-sharing restores
// everything with no repair step.
test.describe('Joint accounts', () => {
  test('grantee sees and works a joint account natively; revoke and re-share round-trip', async ({
    api,
    browser,
  }) => {
    const jointName = `Joint Household ${uniqueId()}`;
    const ownerAccount = await createAccount(api, {
      name: jointName,
      openingBalance: 5000,
    });
    const email = `e2e-joint-${uniqueId()}@test.example.com`;
    const password = E2E_DEFAULT_PASSWORD;
    const delegate = await createDelegate(api, { email, password });

    const granteeContext = await browser.newContext();
    try {
      await loginViaApi(granteeContext.request, email, password);
      const granteeApi = createApiClient(granteeContext.request);

      // The grantee becomes a FULL account (owns data of their own) --
      // the joint toggle is only accepted for real accounts.
      const ownAccount = await granteeApi.post<{ id: string }>('/accounts', {
        name: `Bob Own ${uniqueId()}`,
        accountType: 'CHEQUING',
        currencyCode: 'USD',
        openingBalance: 2000,
      });

      // The owner marks the account joint (create + edit granted).
      await grantDelegateAccount(api, delegate.id, ownerAccount.id, {
        canCreate: true,
        canEdit: true,
        isJoint: true,
      });

      // Native union list: the joint account appears in the grantee's OWN
      // context with the joint metadata -- no context switch anywhere.
      const union = await granteeApi.get<
        Array<{
          id: string;
          isJoint?: boolean;
          ownerLabel?: string;
          jointPermissions?: { canCreate: boolean; canDelete: boolean };
        }>
      >('/accounts');
      const jointRow = union.find((a) => a.id === ownerAccount.id);
      expect(jointRow?.isJoint).toBe(true);
      expect(jointRow?.jointPermissions?.canCreate).toBe(true);
      expect(jointRow?.jointPermissions?.canDelete).toBe(false);

      // And the account page shows it with the Joint badge, natively.
      //
      // The page needs a UI login, not the API-only one above: the auth store
      // persists `isAuthenticated` to localStorage, so a context authenticated
      // by cookies alone still fails ProtectedRoute's check and bounces to
      // /login.
      const granteePage = await granteeContext.newPage();
      await loginUser(granteePage, email, password);
      await gotoStable(granteePage, '/accounts');
      const row = granteePage.locator('tr', { hasText: jointName });
      await expect(row).toBeVisible({ timeout: 15000 });
      await expect(row.getByText('Joint', { exact: true })).toBeVisible();

      // No context switcher: this delegation is purely joint (no section read,
      // no manage capability), so the owner's context would show exactly the
      // account already sitting in this list. /auth/contexts drops it, and the
      // banner has nothing to offer.
      await expect(
        granteePage.locator('#delegation-context-select'),
      ).toHaveCount(0);
      await granteePage.close();

      // Native create lands on the OWNER's ledger and moves their balance.
      const created = await granteeApi.post<{ id: string }>('/transactions', {
        accountId: ownerAccount.id,
        amount: -150,
        transactionDate: '2026-02-01',
        currencyCode: 'USD',
        payeeName: '',
        description: 'groceries run',
      });
      const ownerView = await api.get<{ currentBalance: number }>(
        `/accounts/${ownerAccount.id}`,
      );
      expect(Number(ownerView.currentBalance)).toBe(4850);

      // The grantee's per-account net-worth exclusion round-trips.
      await granteeApi.put(`/accounts/${ownerAccount.id}/net-worth-exclusion`, {
        excluded: true,
      });
      const excludedRow = (
        await granteeApi.get<
          Array<{ id: string; excludeFromNetWorth: boolean }>
        >('/accounts')
      ).find((a) => a.id === ownerAccount.id);
      expect(excludedRow?.excludeFromNetWorth).toBe(true);

      // A native transfer own -> joint works from the grantee's own context.
      const transfer = await granteeApi.post<{
        fromTransaction: { id: string };
      }>('/transactions/transfer', {
        fromAccountId: ownAccount.id,
        toAccountId: ownerAccount.id,
        transactionDate: '2026-02-02',
        amount: 500,
        fromCurrencyCode: 'USD',
      });
      expect(
        Number(
          (
            await api.get<{ currentBalance: number }>(
              `/accounts/${ownerAccount.id}`,
            )
          ).currentBalance,
        ),
      ).toBe(5350);

      // The owner revokes: the account vanishes from the grantee's list,
      // native writes 404, and the transfer counterpart freezes.
      await api.delete(`/delegation/delegates/${delegate.id}`);

      const afterRevoke = await granteeApi.get<Array<{ id: string }>>(
        '/accounts',
      );
      expect(afterRevoke.some((a) => a.id === ownerAccount.id)).toBe(false);

      const blockedCreate = await rawApiRequest(
        granteeContext.request,
        'POST',
        '/transactions',
        {
          accountId: ownerAccount.id,
          amount: -10,
          transactionDate: '2026-02-03',
          currencyCode: 'USD',
        },
      );
      expect(blockedCreate.status()).toBe(404);

      const frozen = await granteeApi.get<{
        linkedTransaction: { account: { name: string } } | null;
      }>(`/transactions/${transfer.fromTransaction.id}`);
      expect(frozen.linkedTransaction?.account?.name).toBe('Hidden account');

      // The grantee's earlier row is untouched on the owner's ledger.
      const ownerRow = await api.get<{ id: string }>(
        `/transactions/${created.id}`,
      );
      expect(ownerRow.id).toBe(created.id);

      // Re-share joint: everything is back with no repair step.
      const reshared = await createDelegate(api, { email, password });
      await grantDelegateAccount(api, reshared.id, ownerAccount.id, {
        canCreate: true,
        canEdit: true,
        isJoint: true,
      });

      const restored = await granteeApi.get<
        Array<{ id: string; isJoint?: boolean }>
      >('/accounts');
      expect(
        restored.find((a) => a.id === ownerAccount.id)?.isJoint,
      ).toBe(true);
      const reconnected = await granteeApi.get<{
        linkedTransaction: { account: { name: string } } | null;
      }>(`/transactions/${transfer.fromTransaction.id}`);
      expect(reconnected.linkedTransaction?.account?.name).toBe(jointName);
    } finally {
      await granteeContext.close();
    }
  });

  test('the joint toggle is rejected for a delegate without a full account', async ({
    authedPage: page,
    api,
  }) => {
    const ownerAccount = await createAccount(api, {
      name: `Joint Reject ${uniqueId()}`,
    });
    const delegate = await createDelegate(api, {
      email: `e2e-joint-pure-${uniqueId()}@test.example.com`,
      password: E2E_DEFAULT_PASSWORD,
    });
    // The delegate never claims a full account, so the joint flag is refused.
    const res = await rawApiRequest(
      page.request,
      'PUT',
      `/delegation/delegates/${delegate.id}/grants`,
      {
        grants: [
          { accountId: ownerAccount.id, canRead: true, isJoint: true },
        ],
      },
    );
    expect(res.status()).toBe(400);
  });
});
