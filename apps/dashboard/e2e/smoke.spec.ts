import { test, expect } from '@playwright/test';

/**
 * Dashboard smoke test.
 *
 * Walks the path that matters: sign in, create a link, change where it
 * points, and confirm the change is recorded in history. If this passes the
 * app is fundamentally working; if it fails, something load-bearing broke.
 */

const EMAIL = process.env['SEED_EMAIL'] ?? 'mig@mttechservices.com';
const PASSWORD = process.env['SEED_PASSWORD'] ?? 'change-me-right-away-123';

test.describe('dashboard', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/login');
    await page.fill('#email', EMAIL);
    await page.fill('#password', PASSWORD);
    await page.click('button[type=submit]');
    await page.waitForURL('**/links');
  });

  test('signs in and lists links', async ({ page }) => {
    await expect(page.getByRole('heading', { name: 'Links' })).toBeVisible();
    await expect(page.locator('button.register-row').first()).toBeVisible();
  });

  test('creates a link, repoints it, and records the change in history', async ({ page }) => {
    const slug = `e2e-${Date.now()}`;

    await page.getByRole('button', { name: 'New link' }).click();
    await page.fill('#new-dest', 'https://example.com/e2e-original');
    await page.fill('#new-slug', slug);
    await page.fill('#new-title', 'E2E smoke test');
    await page.getByRole('button', { name: 'Create link' }).click();

    await expect(page.getByText('Link created and live.')).toBeVisible();
    await page.getByRole('button', { name: 'Done' }).click();

    // Find it and open the drawer.
    await page.fill('input[aria-label="Search links"]', slug);
    const row = page.locator('button.register-row').first();
    await expect(row).toContainText(slug);
    await row.click();

    const drawer = page.getByRole('dialog');
    await expect(drawer).toBeVisible();
    await expect(drawer.locator('#destination')).toHaveValue('https://example.com/e2e-original');

    // Repoint it.
    await drawer.locator('#destination').fill('https://example.com/e2e-changed');
    await drawer.locator('#note').fill('changed by the smoke test');
    await drawer.getByRole('button', { name: 'Save changes' }).click();

    await expect(drawer.getByText('Saved. The new destination is live now.')).toBeVisible();

    // History must show both, newest first, with the note.
    const history = drawer.locator('ol li');
    await expect(history).toHaveCount(2);
    await expect(history.nth(0)).toContainText('example.com/e2e-changed');
    await expect(history.nth(0)).toContainText('Current');
    await expect(history.nth(0)).toContainText('changed by the smoke test');
    await expect(history.nth(1)).toContainText('example.com/e2e-original');

    // Clean up after ourselves.
    page.once('dialog', (d) => void d.accept());
    await drawer.getByRole('button', { name: 'Delete' }).click();
    await expect(drawer).toBeHidden();
  });

  test('rejects a reserved slug with a readable message', async ({ page }) => {
    await page.getByRole('button', { name: 'New link' }).click();
    await page.fill('#new-dest', 'https://example.com/whatever');
    await page.fill('#new-slug', 'admin');
    await page.getByRole('button', { name: 'Create link' }).click();
    await expect(page.getByRole('alert')).toContainText('reserved');
  });

  test('rejects an SSRF destination with a readable message', async ({ page }) => {
    await page.getByRole('button', { name: 'New link' }).click();
    await page.fill('#new-dest', 'http://169.254.169.254/latest/meta-data/');
    await page.getByRole('button', { name: 'Create link' }).click();
    await expect(page.getByRole('alert')).toContainText(/private or reserved/i);
  });

  test('navigates to analytics', async ({ page }) => {
    await page.getByRole('link', { name: 'Analytics' }).click();
    await expect(page.getByRole('heading', { name: 'Analytics' })).toBeVisible();
    await expect(page.getByText('Clicks per day')).toBeVisible();
  });

  test('has no horizontal overflow on a phone viewport', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/links');
    await page.waitForSelector('button.register-row');
    const overflows = await page.evaluate(
      () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
    );
    expect(overflows).toBe(false);
  });
});
