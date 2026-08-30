import { test, expect } from '../fixtures';
import { createAccount } from '../helpers/factories';
import { uniqueId } from '../helpers/api';

// Backup & restore. Export downloads a backup of all the user's data.
//
// Backups are encrypted with the user's own password, captured when they
// register or sign in. `ENCRYPTION_KEY` is required for the backend to start at
// all, so there is no environment in which that capture silently does not
// happen -- this suite therefore drives the encrypted download, prompt and all
// (issue #1269, where the key was optional and every backup came out in clear).
//
// The restore round-trip wipes and replaces all data; driving it end-to-end in
// a browser is deferred (see ROADMAP Phase 3.4) -- the wipe appears to
// invalidate the active session, so asserting the restored data in the same
// page session isn't reliable. Restore is covered by backend tests.
test.describe('Backup & restore', () => {
  test('exports an encrypted backup, asking for the password first', async ({
    authedPage: page,
    api,
    user,
  }) => {
    await createAccount(api, { name: `Backup ${uniqueId()}` });

    await page.goto('/settings');

    // The account's login password was captured at registration, so Settings
    // reports encryption as on and the download asks for it before writing a
    // file only that password can open.
    await expect(page.getByText('Backup Encryption')).toBeVisible();
    // `exact` is load-bearing, not decoration: the panel's description ("Your
    // backups are encrypted with your login password. Nothing else to
    // remember...") CONTAINS the badge note, and getByText matches substrings,
    // so a loose locator resolves to two elements and fails strict mode. Match
    // the note's whole text and only the note matches.
    await expect(
      page.getByText('Backups are encrypted with your login password.', {
        exact: true,
      }),
    ).toBeVisible();

    await page.getByRole('button', { name: 'Download Backup' }).click();

    await expect(
      page.getByRole('heading', { name: 'Encrypt Backup' }),
    ).toBeVisible();
    await page.getByPlaceholder('Login password').fill(user.password);

    const downloadPromise = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Download', exact: true }).click();
    const download = await downloadPromise;

    // `.mzbe` is the encrypted envelope; `.json.gz` would mean the capture did
    // not happen, which is the defect this suite exists to catch.
    expect(download.suggestedFilename()).toMatch(/monize-backup.*\.mzbe$/);
  });

  test('hides automatic backup settings from a non-admin', async ({
    authedPage: page,
  }) => {
    await page.goto('/settings');
    await expect(page.getByText('Create Backup')).toBeVisible();

    // Automatic backups are configured by an administrator and applied to
    // everyone else; a plain user has nothing to set here.
    await expect(page.getByText('Automatic Backup')).toHaveCount(0);
  });

  test('shows automatic backup settings to an admin', async ({ adminPage }) => {
    await adminPage.goto('/settings');

    await expect(
      adminPage.getByRole('heading', { name: 'Automatic Backup' }),
    ).toBeVisible();
  });
});
