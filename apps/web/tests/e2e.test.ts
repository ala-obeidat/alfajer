import { test, expect } from '@playwright/test';

// Landing-page smoke test. Runs on every configured engine (chromium / firefox
// / webkit) via the default `page` fixture, so it doubles as a cheap
// cross-engine render check of the static shell.
//
// (Replaces a stale test that asserted an Arabic h1 + an "English" language
// toggle — neither of which exists on the current landing page.)
test('landing page renders the core call entry points', async ({ page }) => {
  await page.goto('/');

  await expect(page.locator('h1')).toHaveText('Alfajer');
  await expect(page.locator('input[placeholder="What should we call you?"]')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Start new call' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Join existing call' })).toBeVisible();
});
