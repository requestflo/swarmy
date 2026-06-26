import { expect, test } from '@playwright/test';

test('marketing site renders hero and features', async ({ page }) => {
  await page.goto('/');

  await expect(page).toHaveTitle(/swarmy/i);
  await expect(page.getByRole('heading', { level: 1 })).toContainText(/Docker Swarm controller/i);
  await expect(page.getByRole('link', { name: /get started/i }).first()).toBeVisible();

  await expect(page.getByRole('heading', { name: 'Pluggable ingress' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Live cluster stats' })).toBeVisible();
});
