import { test, expect } from '@playwright/test';

test('has title and can toggle language', async ({ page }) => {
  await page.goto('/');

  // Default is Arabic
  await expect(page.locator('h1')).toHaveText('مرحباً بك في الفجر');

  // Click Language Toggle
  await page.click('button:has-text("English")');

  // Should switch to English
  await expect(page.locator('h1')).toHaveText('Welcome to Alfajer');
});
