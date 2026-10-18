import { test, expect } from '@playwright/test';

const id = 'ORD-WEBHOOK-DEMO-20261018';
function fixture(status = 'failed') {
  return {
    connected: true, portalId: '247703851', checkedAt: '2026-10-18T13:00:00Z',
    summary: { total: 1, succeeded: status === 'succeeded' ? 1 : 0, failed: status === 'failed' ? 1 : 0, inFlightOrders: 0 },
    attempts: [{
      id: '1', orderId: 'SYNTHETIC-UI-ORDER', attemptStatus: status,
      orderStatus: status === 'succeeded' ? 'synced' : status,
      contactId: '8001', dealId: '9001', error: status === 'failed' ? 'HubSpot rate_limited (HTTP 429)' : null,
      startedAt: '2026-10-18T12:00:00Z', finishedAt: '2026-10-18T12:01:00Z', retryEligible: status === 'failed',
      trigger: 'webhook', nextRetryAt: status === 'failed' ? '2026-10-18T12:05:00Z' : null, autoRetryCount: 0,
    }],
  };
}

test('real history shows both attempts and blocks retries on the synced order', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('connection')).toHaveText('Backend connected');
  const rows = page.getByRole('row').filter({ hasText: id });
  await expect(rows).toHaveCount(2);
  await expect(rows.filter({ hasText: 'succeeded' })).toHaveCount(1);
  await expect(rows.filter({ hasText: 'failed' })).toHaveCount(1);
  await expect(rows.getByRole('button', { name: 'Retry', exact: true })).toHaveCount(0);
  await expect(rows.first()).toContainText('synced');
  await expect(rows.first().getByRole('link').first()).toHaveAttribute('href', /247703851\/record\/0-1\/572087515841/);
  await page.screenshot({ path: 'artifacts/dashboard-desktop.png', fullPage: true });
  await rows.filter({ hasText: 'failed' }).getByRole('button', { name: 'View error' }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await expect(page.getByRole('dialog')).toContainText('Current order: synced');
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect(page.getByTestId('connection')).toHaveText('Backend connected');
});

test('browser-facing API requires login and blocks cross-origin mutations', async ({ request }) => {
  // Native fetch does not inherit the Playwright project's HTTP credentials.
  expect((await fetch('http://localhost:3000/api/dashboard')).status).toBe(401);
  expect((await fetch('http://localhost:3000/api/orders/' + id + '/retry', { method: 'POST' })).status).toBe(401);
  expect((await request.post('/api/orders/' + id + '/retry', { headers: { Origin: 'https://untrusted.example' } })).status()).toBe(403);
  expect((await request.post('/api/orders/' + id + '/retry', { headers: { Origin: 'http://localhost:3000' } })).status()).toBe(409);
});

test('loading and empty states are explicit', async ({ page }) => {
  let release!: () => void;
  const wait = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/api/dashboard', async route => {
    await wait;
    const data = fixture(); data.attempts = []; data.summary = { total: 0, succeeded: 0, failed: 0, inFlightOrders: 0 };
    await route.fulfill({ json: data });
  });
  await page.goto('/');
  await expect(page.getByTestId('connection')).toHaveText('Checking API…');
  release();
  await expect(page.getByText('No synchronization attempts yet')).toBeVisible();
  await expect(page.getByText(/No retryable orders/)).toBeVisible();
});

test('backend outage never reports a successful connection', async ({ page }) => {
  await page.route('**/api/dashboard', route => route.fulfill({ status: 503, json: { connected: false, error: 'Backend unavailable for testing.' } }));
  await page.goto('/');
  await expect(page.getByTestId('connection')).toHaveText('Backend unavailable');
  await expect(page.getByRole('alert').filter({ hasText: 'Backend unavailable for testing.' })).toBeVisible();
});

test('retry confirmation, cancel, progress, success and refresh', async ({ page }) => {
  let succeeded = false, count = 0, release!: () => void;
  const wait = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/api/dashboard', route => route.fulfill({ json: fixture(succeeded ? 'succeeded' : 'failed') }));
  await page.route('**/api/orders/*/retry', async route => {
    count++; await wait; succeeded = true;
    await route.fulfill({ json: { status: 'synced', message: 'Order synchronized successfully' } });
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'Retry', exact: true }).click();
  await expect(page.getByRole('dialog')).toContainText('Retry this order?');
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  expect(count).toBe(0);
  await page.getByRole('button', { name: 'Retry', exact: true }).click();
  await page.getByRole('button', { name: 'Confirm retry', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Retrying…' })).toBeDisabled();
  release();
  await expect(page.getByText('Order synchronized successfully')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Retry', exact: true })).toHaveCount(0);
  await expect(page.getByText('Up to date')).toBeVisible();
  await expect(page.getByTestId('next-retry')).toHaveCount(0);
  expect(count).toBe(1);
});

test('retry failure is visible and full error details remain available', async ({ page }) => {
  await page.route('**/api/dashboard', route => route.fulfill({ json: fixture() }));
  await page.route('**/api/orders/*/retry', route => route.fulfill({ status: 503, json: { message: 'Synchronization failed. Attempt recorded.' } }));
  await page.goto('/');
  await expect(page.getByTestId('next-retry')).toContainText('Auto retry');
  await expect(page.getByText('Attempt #1 · webhook')).toBeVisible();
  await page.getByRole('button', { name: 'Retry', exact: true }).click();
  await page.getByRole('button', { name: 'Confirm retry', exact: true }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'Synchronization failed.' })).toBeVisible();
  await page.getByRole('button', { name: 'View error' }).click();
  await expect(page.getByRole('dialog')).toContainText('HubSpot rate_limited (HTTP 429)');
});

test('mobile layout scrolls the table without overflowing the page', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await expect(page.getByTestId('connection')).toHaveText('Backend connected');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  const table = page.getByRole('table');
  expect(await table.evaluate(el => el.parentElement!.scrollWidth > el.parentElement!.clientWidth)).toBe(true);
  await page.screenshot({ path: 'artifacts/dashboard-mobile.png', fullPage: true });
});
