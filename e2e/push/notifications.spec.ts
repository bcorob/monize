import { test, expect, shown } from './fixture';

const reminder = {
  type: 'BILL_DUE',
  title: 'Rent due',
  body: 'Rent needs attention',
  target: '/bills',
  collapseKey: 'rent',
  reminderId: '00000000-0000-4000-8000-000000000001',
  actions: [{ action: 'stop-reminder', title: 'Stop' }],
};

test('displays real notifications, replaces the same subject and keeps another subject', async ({
  pushHarness: h,
}) => {
  await h.push(reminder);
  await expect
    .poll(() => shown(h.worker))
    .toMatchObject([
      {
        title: 'Rent due',
        body: 'Rent needs attention',
        data: { target: '/bills', reminderId: reminder.reminderId },
      },
    ]);
  await h.push({ ...reminder, title: 'Rent updated' });
  await expect.poll(() => shown(h.worker)).toMatchObject([{ title: 'Rent updated' }]);
  await h.push({ ...reminder, collapseKey: 'utilities', title: 'Utilities due' });
  await expect
    .poll(async () => (await shown(h.worker)).map((n) => n.title).sort())
    .toEqual(['Rent updated', 'Utilities due']);
});

for (const target of ['/bills', 'https://hostile.example/steal']) {
  test(`body click safely navigates an existing window: ${target}`, async ({
    page,
    pushHarness: h,
  }) => {
    await h.push({ ...reminder, target });
    await expect.poll(async () => (await shown(h.worker)).length).toBe(1);
    await h.click();
    await expect(page).toHaveURL(h.origin + (target === '/bills' ? '/bills' : '/'));
    await expect.poll(async () => (await shown(h.worker)).length).toBe(0);
    expect(h.requests).toEqual([]);
  });
}

test('Stop sends browser session and Cookie Store CSRF without navigating', async ({
  page,
  pushHarness: h,
}) => {
  await h.push(reminder);
  await expect.poll(async () => (await shown(h.worker)).length).toBe(1);
  await h.click('stop-reminder');
  await expect
    .poll(() => h.requests)
    .toEqual([
      {
        path: `/api/v1/notifications/reminders/${reminder.reminderId}/stop`,
        method: 'POST',
        cookie: expect.stringContaining('session=browser-session'),
        csrf: 'browser-csrf',
      },
    ]);
  await expect.poll(async () => (await shown(h.worker)).length).toBe(0);
  await expect(page).toHaveURL(h.origin + '/initial');
});

test('Stop refreshes an expired session once and retries', async ({ pushHarness: h }) => {
  h.stopStatuses = [401, 201];
  await h.push(reminder);
  await expect.poll(async () => (await shown(h.worker)).length).toBe(1);
  await h.click('stop-reminder');
  const stop = `/api/v1/notifications/reminders/${reminder.reminderId}/stop`;
  await expect
    .poll(() => h.requests.map((r) => r.path))
    .toEqual([stop, '/api/v1/auth/refresh', stop]);
  expect(h.requests.filter((r) => r.path === stop).map((r) => r.csrf)).toEqual([
    'browser-csrf',
    'browser-csrf-refreshed',
  ]);
});

for (const status of [401, 403]) {
  test(`failed Stop opens reminders (${status})`, async ({ page, pushHarness: h }) => {
    h.stopStatuses = [status];
    h.refreshStatus = 401;
    await h.push(reminder);
    await expect.poll(async () => (await shown(h.worker)).length).toBe(1);
    await h.click('stop-reminder');
    await expect(page).toHaveURL(h.origin + '/reminders');
    expect(h.requests.length).toBe(status === 401 ? 2 : 1);
  });
}

for (const expired of [false, true]) {
  test(`Stop obtains JSON CSRF without Cookie Store (expired session: ${expired})`, async ({
    page,
    pushHarness: h,
  }) => {
    // Exercise the portable path in Chromium. Native Firefox/Safari push and
    // OS action delivery are still a separate manual browser check.
    await h.worker.evaluate(() => {
      Object.defineProperty(self, 'cookieStore', { value: undefined, configurable: true });
    });
    if (expired) h.stopStatuses = [401, 201];
    await h.push(reminder);
    await expect.poll(async () => (await shown(h.worker)).length).toBe(1);
    await h.click('stop-reminder');
    const token = '/api/v1/auth/csrf-refresh';
    const stop = `/api/v1/notifications/reminders/${reminder.reminderId}/stop`;
    expect(h.requests.map((r) => r.path)).toEqual(
      expired ? [token, stop, '/api/v1/auth/refresh', token, stop] : [token, stop],
    );
    expect(h.requests.filter((r) => r.path === stop).map((r) => r.csrf)).toEqual(
      expired ? ['browser-csrf', 'browser-csrf-refreshed'] : ['browser-csrf'],
    );
    await expect(page).toHaveURL(h.origin + '/initial');
    await expect.poll(async () => (await shown(h.worker)).length).toBe(0);
  });
}
