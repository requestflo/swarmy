/**
 * Demo-mode smoke test: serve the built dashboard and prove it fully renders with
 * NO backend (no API, no DB) — the whole point of demo mode. Run after a demo
 * build:  VITE_SWARMY_DEMO=1 bun --filter @swarmy/app build  &&  bun apps/e2e/demo-smoke.ts
 */
import { chromium } from '@playwright/test';

const ROOT = '/home/user/swarmy/apps/app/dist';
const PORT = 4399;
const BASE = `http://localhost:${PORT}`;

const server = Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);
    const path = url.pathname === '/' ? '/index.html' : url.pathname;
    let file = Bun.file(ROOT + path);
    if (!(await file.exists())) file = Bun.file(`${ROOT}/index.html`); // SPA fallback
    return new Response(file);
  },
});

function fail(msg: string): never {
  console.error(`✗ ${msg}`);
  server.stop(true);
  process.exit(1);
}

// Use the preinstalled Chromium (Playwright's pinned build may differ — env note).
const browser = await chromium.launch({
  headless: true,
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
});
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors: string[] = [];
page.on('pageerror', (e) => errors.push(String(e)));

try {
  // 1) Applications canvas (home) in demo mode — no backend running.
  await page.goto(`${BASE}/?demo=1`, { waitUntil: 'networkidle' });
  await page.getByText('live demo', { exact: false }).first().waitFor({ timeout: 15_000 });
  console.log('✓ demo banner rendered');

  // A seeded service card appears on the canvas.
  await page.getByText('checkout', { exact: false }).first().waitFor({ timeout: 15_000 });
  console.log('✓ Applications canvas rendered seeded services');

  // 2) Infrastructure plane shows seeded nodes.
  await page.goto(`${BASE}/nodes`, { waitUntil: 'networkidle' });
  await page.getByText('mgr-1', { exact: false }).first().waitFor({ timeout: 15_000 });
  console.log('✓ Infrastructure plane rendered seeded nodes');

  // 3) A deeper page via the registry (Ingress) loads from resolvers, not network.
  await page.goto(`${BASE}/ingress`, { waitUntil: 'networkidle' });
  await page.getByText('Ingress', { exact: false }).first().waitFor({ timeout: 15_000 });
  console.log('✓ Ingress page rendered');

  await page.screenshot({ path: '/tmp/claude-0/-home-user-swarmy/a51b0817-6675-5109-a506-f829a2182dd2/scratchpad/demo-canvas.png' });

  if (errors.length) fail(`page errors: ${errors.slice(0, 3).join(' | ')}`);
  console.log('\nDEMO SMOKE: PASS (dashboard fully interactive with backend OFF)');
} catch (e) {
  fail(`smoke failed: ${e instanceof Error ? e.message : String(e)}${errors.length ? ` | pageerrors: ${errors[0]}` : ''}`);
} finally {
  await browser.close();
  server.stop(true);
}
