/**
 * Demo smoke test: serve the static demo build of the dashboard and prove it
 * works with NO backend. Every route renders, the demo banner is on screen,
 * and no request ever goes to a controller path (/api, /term, /agent, ...).
 *
 *   bun --filter @swarmy/app build:demo && bun apps/e2e/demo-smoke.ts
 *
 * Env: DEMO_ROOT (default apps/app/dist/demo), DEMO_BASE_URL (test an already
 * running server, e.g. the demo image on :8080, instead of serving DEMO_ROOT),
 * PW_CHROMIUM_PATH (use a preinstalled Chromium), SMOKE_SCREENSHOT_DIR.
 */
import path from 'node:path';
import { chromium } from '@playwright/test';

const ROOT = process.env.DEMO_ROOT ?? path.resolve(import.meta.dir, '../app/dist/demo');
const CONTROLLER_PATH = /^\/(api|term|agent|install|_app-auth|status)(\/|$)/;

/** Every path the static server was asked for: the real proof nothing hit a backend. */
const served: string[] = [];
let server: ReturnType<typeof Bun.serve> | null = null;
let BASE = process.env.DEMO_BASE_URL?.replace(/\/$/, '');
if (!BASE) {
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      served.push(url.pathname);
      if (CONTROLLER_PATH.test(url.pathname)) return new Response('no controller in the demo', { status: 404 });
      const file = Bun.file(path.join(ROOT, url.pathname === '/' ? 'index.html' : url.pathname));
      // SPA fallback, as Caddy's try_files does in the demo image.
      return new Response((await file.exists()) ? file : Bun.file(path.join(ROOT, 'index.html')));
    },
  });
  BASE = `http://localhost:${server.port}`;
}
const origin = new URL(BASE).origin;

const browser = await chromium.launch({
  headless: true,
  ...(process.env.PW_CHROMIUM_PATH ? { executablePath: process.env.PW_CHROMIUM_PATH } : {}),
});
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const pageErrors: string[] = [];
const badRequests: string[] = [];
page.on('pageerror', (e) => pageErrors.push(String(e)));
page.on('request', (req) => {
  const u = new URL(req.url());
  if (u.protocol === 'data:' || u.protocol === 'blob:') return;
  if (u.origin !== origin || CONTROLLER_PATH.test(u.pathname)) badRequests.push(`${req.method()} ${req.url()}`);
});

let failures = 0;
function fail(msg: string): void {
  failures++;
  console.error(`✗ ${msg}`);
}

async function visit(route: string, expect?: RegExp, banner = true): Promise<void> {
  const before = pageErrors.length;
  await page.goto(`${BASE}${route}`, { waitUntil: 'networkidle' });
  if (banner) {
    try {
      await page.getByTestId('demo-banner').first().waitFor({ timeout: 10_000 });
    } catch {
      return fail(`${route}: no demo banner`);
    }
  }
  // Give lazy chunks and the demo link's simulated latency time to settle.
  await page.waitForTimeout(400);
  const body = await page.locator('body').innerText();
  // TanStack Router's error boundary; the catch-all route bounces unknown paths to /overview.
  if (/Something went wrong!/.test(body)) return fail(`${route}: error screen`);
  const landed = new URL(page.url()).pathname;
  if (landed !== route.split('?')[0]) return fail(`${route}: redirected to ${landed}`);
  if (expect && !expect.test(body)) return fail(`${route}: expected ${expect}`);
  if (pageErrors.length > before) return fail(`${route}: ${pageErrors.slice(before).join(' | ')}`);
  console.log(`✓ ${route}`);
}

/**
 * Open `from`, then follow its first link matching `href` with a client-side
 * click: some ids (traces, replays) are generated per page load, so a fresh
 * page.goto to them would miss. Returns the path it landed on.
 */
async function follow(from: string, href: RegExp): Promise<string | null> {
  await page.goto(`${BASE}${from}`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(600);
  const hrefs = await page.locator('a[href]').evaluateAll((as) => as.map((a) => a.getAttribute('href') ?? ''));
  const target = hrefs.find((h) => href.test(h));
  if (!target) return null;
  const before = pageErrors.length;
  await page.locator(`a[href="${target}"]`).first().click();
  await page.waitForURL((u) => u.pathname === target.split('?')[0], { timeout: 10_000 });
  await page.waitForTimeout(600);
  const body = await page.locator('body').innerText();
  if (!(await page.getByTestId('demo-banner').count())) fail(`${target}: no demo banner`);
  else if (/Something went wrong!|Trace not found/.test(body)) fail(`${target}: error or not-found screen`);
  else if (pageErrors.length > before) fail(`${target}: ${pageErrors.slice(before).join(' | ')}`);
  else console.log(`✓ ${target} (via ${from})`);
  return target;
}

const routes: Array<[string, RegExp?]> = [
  ['/', /storefront/i],
  ['/overview'],
  ['/nodes'],
  ['/nodes/new'],
  ['/nodes/n-mgr-1', /mgr-1/],
  ['/nodes/n-wkr-1/terminal'],
  ['/services/svc-api'],
  ['/services/svc-api/terminal'],
  ['/services/new'],
  ['/stacks/new'],
  ['/stacks/storefront', /storefront/i],
  ['/stacks/storefront/observability'],
  ['/stacks/storefront/releases'],
  ['/stacks/storefront/config'],
  ['/stacks/storefront/network'],
  ['/stacks/storefront/settings'],
  ['/stacks/storefront/access'],
  ['/stacks/storefront/analytics'],
  ['/stacks/storefront/errors'],
  ['/stacks/storefront/replays'],
  ['/stacks/storefront/rum-settings'],
  ['/stacks/storefront/messaging'],
  ['/stacks/storefront/backups'],
  ['/stacks/data/data'],
  ['/stacks/data/studio'],
  ['/stacks/data/messaging'],
  ['/stacks/data/queues/main'],
  ['/ingress'],
  ['/networking'],
  ['/ci'],
  ['/backups'],
  ['/alerts'],
  ['/incidents'],
  ['/incidents/inc-failover-main-db'],
  ['/cost'],
  ['/audit'],
  ['/governance'],
  ['/blueprints'],
  ['/email'],
  ['/ai'],
  ['/data/buckets'],
  ['/device'],
  ['/settings'],
  ['/settings/access'],
  ['/settings/api-keys'],
  ['/settings/platform'],
  ['/terminal/sessions/term-1'],
  // Outside the shell: the sign-in screens become demo notices.
  ['/login', /no sign-in needed/i],
  ['/app-login', /no sign-in needed/i],
];

try {
  for (const [route, expect] of routes) await visit(route, expect);
  // A stack's public status page is the app's own page, not the dashboard: no banner.
  await visit('/s/requestflo-status', /operational|degraded|outage|status/i, false);

  // Param routes whose ids exist only in the page that links to them.
  const discovered: Array<[string, RegExp]> = [
    ['/ci', /^\/ci\/[^/]+$/],
    ['/stacks/storefront/observability', /^\/observability\/[^/]+$/],
    ['/stacks/storefront/replays', /\/replays\/[^/]+$/],
  ];
  for (const [from, re] of discovered) {
    if (!(await follow(from, re))) console.log(`- no ${re} link on ${from} (skipped)`);
  }

  // The node shell shows the demo notice instead of opening a socket.
  await page.goto(`${BASE}/nodes/n-mgr-1/terminal`, { waitUntil: 'networkidle' });
  await page.getByRole('button', { name: /open node shell/i }).click();
  try {
    await page.getByTestId('demo-unavailable').waitFor({ timeout: 5_000 });
    console.log('✓ node shell shows the demo notice');
  } catch {
    fail('node shell: no demo notice after Open node shell');
  }

  // The banner links back out.
  await page.goto(`${BASE}/`, { waitUntil: 'networkidle' });
  const links = await page
    .getByTestId('demo-banner')
    .locator('a')
    .evaluateAll((as) => as.map((a) => (a as HTMLAnchorElement).href));
  if (!links.some((h) => /\/docs\/getting-started\/install$/.test(h))) fail(`banner has no install-docs link (${links})`);
  else console.log(`✓ banner links: ${links.join(', ')}`);

  if (process.env.SMOKE_SCREENSHOT_DIR) {
    await page.screenshot({ path: path.join(process.env.SMOKE_SCREENSHOT_DIR, 'demo-home.png') });
  }
} finally {
  await browser.close();
  server?.stop(true);
}

const hitController = served.filter((p) => CONTROLLER_PATH.test(p));
if (badRequests.length) fail(`requests left the static bundle:\n  ${[...new Set(badRequests)].join('\n  ')}`);
if (hitController.length) fail(`the server saw controller requests: ${[...new Set(hitController)].join(', ')}`);
if (failures) {
  console.error(`\n${failures} demo smoke failure(s)`);
  process.exit(1);
}
console.log(`\n✓ demo smoke passed: ${routes.length}+ routes, banner on every page, no controller requests`);
