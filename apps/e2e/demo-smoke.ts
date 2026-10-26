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
  // The Calm Layers shell's top-level destinations.
  ['/deploy'],
  ['/network', /How a visit reaches your apps/],
  // Board 15: each database's copies by server; the writer moves by a planned switch-over.
  ['/data', /Where each database’s copies run[\s\S]*standby copies stay where they were placed/],
  ['/activity'],
  ['/nodes'],
  ['/nodes/new'],
  // Placement & volumes' "Move…" opens the move picker for that service.
  ['/nodes?move=svc-postgres', /Move postgres to/],
  ['/nodes/n-mgr-1', /mgr-1/],
  // Agent ↔ controller skew: the demo's one stale agent says so in plain words.
  ['/nodes/n-wkr-2', /agent is two versions behind/],
  ['/nodes/n-wkr-1/terminal'],
  ['/services/svc-api'],
  ['/services/svc-api/terminal'],
  ['/services/new'],
  ['/deploy/heroku', /Bring a Heroku app across[\s\S]*With a Heroku token/],
  ['/stacks/new'],
  ['/stacks/storefront', /storefront/i],
  // The app canvas (board 7): data stores, the tool row, connect mode.
  ['/stacks/data', /How it is built[\s\S]*Connect[\s\S]*Compose/],
  ['/stacks/storefront/observability'],
  ['/stacks/storefront/releases'],
  ['/stacks/storefront/config'],
  ['/stacks/storefront/network', /Protections/],
  ['/stacks/storefront/network?domain=api.northwind.dev', /Certificate/],
  ['/stacks/storefront/config/scaling'],
  // Health & rollout: the live check, Docker's real probe count, Test now.
  ['/stacks/storefront/config/rollout', /Health check[\s\S]*Last \d+ probes[\s\S]*Test now/],
  ['/stacks/storefront/config/placement'],
  ['/stacks/storefront/config/jobs'],
  ['/stacks/storefront/config/paste', /Paste a \.env into/],
  ['/stacks/storefront/config/previews', /New preview from a branch/],
  ['/stacks/storefront/config/email', /sends mail as app-storefront/],
  ['/stacks/storefront/source'],
  // Convert to swarmy.yaml: a compose app's spec as the file, what didn't translate, the next step.
  ['/stacks/data/source', /Convert to swarmy\.yaml/],
  ['/stacks/data/source?convert=1', /valid · v1[\s\S]*What didn’t translate[\s\S]*privileged/],
  ['/stacks/storefront/access', /Request to/],
  ['/stacks/storefront/analytics'],
  ['/stacks/storefront/errors'],
  ['/stacks/storefront/replays'],
  ['/stacks/storefront/rum-settings'],
  ['/stacks/storefront/backups'],
  ['/stacks/storefront/time-travel', /right now/],
  // Volumes say their size and server; wkr-2's older agent doesn't report sizes.
  ['/stacks/data/config/placement', /stays on wkr-1 with its data[\s\S]*4\.2 GB on wkr-1[\s\S]*Size not reported/],
  ['/stacks/data/data'],
  ['/stacks/storefront/data', /cache/i],
  ['/stacks/storefront/data/checkout', /Connection pooler[\s\S]*On, in transaction mode[\s\S]*prepared statements, LISTEN\/NOTIFY, advisory locks[\s\S]*Switch-over/],
  ['/stacks/data/data/main', /Connection pooler[\s\S]*Off\. Apps connect to the main copy directly\./],
  ['/stacks/data/studio'],
  ['/stacks/data/queues'],
  ['/stacks/data/queues/main'],
  ['/ingress', /Which servers are edges/],
  ['/networking', /Who talks to whom/],
  ['/networking/settings', /active grants/i],
  // Board 43's access rules, in plain words.
  ['/networking/settings', /Servers can reach Databases on 5432/],
  ['/network/connections', /isolated by default/i],
  ['/network/geo-dns', /Ask from anywhere/],
  ['/network/geo-dns?zone=northwind.io', /Cloudflare/],
  ['/ci', /Supply-chain gate[\s\S]*never public/],
  ['/backups'],
  ['/alerts'],
  // Incidents live in Activity (the old /incidents URLs redirect here).
  ['/activity?filter=incident'],
  ['/activity?incident=inc-failover-main-db'],
  ['/status-pages'],
  ['/cost'],
  ['/audit'],
  ['/governance'],
  ['/blueprints'],
  ['/email'],
  ['/ai', /answer repeat questions/],
  ['/data/buckets'],
  ['/data/buckets/storefront-media', /Who can reach it/],
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
  await visit('/s/northwind-status', /operational|degraded|outage|status/i, false);

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
  await page.getByRole('button', { name: /open (node|the) shell/i }).click();
  try {
    await page.getByTestId('demo-unavailable').waitFor({ timeout: 5_000 });
    console.log('✓ node shell shows the demo notice');
  } catch {
    fail('node shell: no demo notice after Open node shell');
  }

  // Board 24: Link & scan a folder with no swarmy.yaml → what its code needs + a valid generated swarmy.yaml.
  try {
    const before = pageErrors.length;
    await page.goto(`${BASE}/deploy?source=git`, { waitUntil: 'networkidle' });
    await page.getByRole('button', { name: /northwind\/platform/ }).first().click();
    await page.locator('section[aria-label="Folder"] button', { hasText: 'orders' }).first().click();
    await page.getByRole('button', { name: /Link & scan/ }).first().click();
    await page.getByText('Here’s what we found').first().waitFor({ timeout: 10_000 });
    await page.getByText('valid · v1').first().waitFor({ timeout: 10_000 });
    await page.getByRole('checkbox', { name: 'Include S3 object storage' }).click();
    await page.waitForFunction(() => !document.querySelector('pre[aria-label$="generated"]')?.textContent?.includes('S3_BUCKET'), null, { timeout: 5_000 });
    if (pageErrors.length > before) fail(`git scan board: ${pageErrors.slice(before).join(' | ')}`);
    else console.log('✓ git wizard: Link & scan → what we found, unticking rewrites the swarmy.yaml');
  } catch (e) {
    fail(`git scan board: ${e instanceof Error ? e.message.split('\n')[0] : String(e)}`);
  }

  // Board 24, Heroku: a Procfile + app.json → "Looks like a Heroku app", the importer's draft and the data steps.
  try {
    const before = pageErrors.length;
    await page.goto(`${BASE}/deploy?source=git`, { waitUntil: 'networkidle' });
    await page.getByRole('button', { name: /northwind\/shop-classic/ }).first().click();
    await page.getByRole('button', { name: /Link & scan/ }).first().click();
    await page.getByText('Looks like a Heroku app').first().waitFor({ timeout: 10_000 });
    await page.getByText('Bring the data and config across').first().waitFor({ timeout: 5_000 });
    const draftHas = (text: string) =>
      page.waitForFunction((t) => document.querySelector('pre[aria-label$="generated"]')?.textContent?.includes(t), text, { timeout: 5_000 });
    await draftHas('Imported from Heroku');
    await page.getByRole('checkbox', { name: 'Use the Heroku import' }).click();
    await draftHas('Generated by swarmy');
    if (pageErrors.length > before) fail(`heroku scan board: ${pageErrors.slice(before).join(' | ')}`);
    else console.log('✓ git wizard: a Heroku repo → "Looks like a Heroku app", the import as the draft, untick → generated');
  } catch (e) {
    fail(`heroku scan board: ${e instanceof Error ? e.message.split('\n')[0] : String(e)}`);
  }

  // Import from Heroku: Deploy → the importer; pasted files → the plan in plain words → Deploy → copy the data.
  try {
    const before = pageErrors.length;
    await page.goto(`${BASE}/deploy`, { waitUntil: 'networkidle' });
    await page.getByRole('link', { name: 'Import from Heroku' }).first().click();
    await page.waitForURL((u) => u.pathname === '/deploy/heroku', { timeout: 10_000 });
    await page.getByRole('radio', { name: 'Paste the files' }).click();
    await page.getByRole('button', { name: 'Use a sample app' }).click();
    await page.getByRole('button', { name: 'Review the plan' }).click();
    await page.getByText('shop-classic comes across as 2 services, a Postgres database and a cache.').first().waitFor({ timeout: 10_000 });
    await page.getByText('Didn’t come across').first().waitFor({ timeout: 5_000 });
    await page.getByRole('button', { name: 'Deploy', exact: true }).click();
    await page.getByText('What Deploy did').first().waitFor({ timeout: 10_000 });
    await page.getByLabel('Type shop-classic/db to copy').fill('shop-classic/db');
    await page.getByRole('button', { name: 'Copy the data' }).click();
    await page.getByText('Copied: db now has 38 tables from Heroku.').first().waitFor({ timeout: 10_000 });
    if (pageErrors.length > before) fail(`heroku import: ${pageErrors.slice(before).join(' | ')}`);
    else console.log('✓ heroku import: pasted files → plan in plain words → Deploy → typed copy of the data');
  } catch (e) {
    fail(`heroku import: ${e instanceof Error ? e.message.split('\n')[0] : String(e)}`);
  }

  // Board 10: step the head back → calls on the replay, rows since the save, then put the whole app back (typed).
  try {
    const before = pageErrors.length;
    await page.goto(`${BASE}/stacks/storefront/time-travel`, { waitUntil: 'networkidle' });
    for (let i = 0; i < 3; i++) await page.keyboard.press('ArrowLeft');
    await page.getByText(/^Put all of storefront back to /).first().waitFor({ timeout: 10_000 });
    await page.getByText(/^Lines are calls the traces saw/).first().waitFor({ timeout: 10_000 });
    await page.getByText(/rows changed since this save\.$/).first().waitFor({ timeout: 10_000 });
    await page.getByLabel('Type storefront to confirm').last().fill('storefront');
    await page.getByRole('button', { name: 'Put the whole app back' }).click();
    await page.getByText(/^storefront is back as it was at /).first().waitFor({ timeout: 15_000 });
    if (pageErrors.length > before) fail(`time travel: ${pageErrors.slice(before).join(' | ')}`);
    else console.log('✓ time travel: calls on the replay, rows changed since the save, whole app put back (typed)');
  } catch (e) {
    fail(`time travel: ${e instanceof Error ? e.message.split('\n')[0] : String(e)}`);
  }

  // Convert to swarmy.yaml: Source tab → the generated file, checked, with Connect a repo as the next step.
  try {
    const before = pageErrors.length;
    await page.goto(`${BASE}/stacks/data/source`, { waitUntil: 'networkidle' });
    await page.getByRole('link', { name: 'Convert to swarmy.yaml' }).first().click();
    await page.getByText('valid · v1').first().waitFor({ timeout: 10_000 });
    await page.getByText('What didn’t translate').first().waitFor({ timeout: 5_000 });
    const next = await page.getByRole('link', { name: 'Connect a repo' }).first().getAttribute('href');
    if (next !== '/deploy?source=git') fail(`convert: Connect a repo goes to ${next}`);
    else if (pageErrors.length > before) fail(`convert: ${pageErrors.slice(before).join(' | ')}`);
    else console.log('✓ convert: compose app → swarmy.yaml (valid · v1), what didn’t translate, Connect a repo');
  } catch (e) {
    fail(`convert: ${e instanceof Error ? e.message.split('\n')[0] : String(e)}`);
  }

  // An address's own front door (Controls): only what the org runs, and a pick saves on the route.
  try {
    const before = pageErrors.length;
    await page.goto(`${BASE}/stacks/storefront/network?domain=cdn.northwind.dev`, { waitUntil: 'networkidle' });
    await page.getByRole('group', { name: 'Detail on this page' }).getByRole('button', { name: 'Controls' }).first().click();
    const picker = page.getByRole('radiogroup', { name: 'Which front door serves cdn.northwind.dev' });
    await picker.waitFor({ timeout: 10_000 });
    const tunnel = picker.getByRole('radio', { name: 'Through your Cloudflare Tunnel' });
    if ((await tunnel.getAttribute('aria-checked')) !== 'true') throw new Error('cdn is not on the tunnel');
    await picker.getByRole('radio', { name: 'The front door' }).click();
    await page.waitForFunction(
      () => document.querySelector('[role="radio"][aria-checked="true"]')?.textContent === 'The front door',
      null,
      { timeout: 10_000 },
    );
    if (pageErrors.length > before) fail(`route driver: ${pageErrors.slice(before).join(' | ')}`);
    else console.log('✓ route driver: cdn rides the tunnel at Controls; picking the front door saves on the route');
  } catch (e) {
    fail(`route driver: ${e instanceof Error ? e.message.split('\n')[0] : String(e)}`);
  }

  // Board 39 at Controls: make checkout's standby on mgr-2 the writer, and watch the run finish.
  try {
    const before = pageErrors.length;
    await page.goto(`${BASE}/stacks/storefront/data/checkout`, { waitUntil: 'networkidle' });
    await page.getByRole('group', { name: 'Detail on this page' }).getByRole('button', { name: 'Controls' }).first().click();
    const make = page.getByRole('button', { name: 'Make this copy the writer' }).first();
    await make.waitFor({ timeout: 10_000 });
    await page.waitForFunction(() => [...document.querySelectorAll('button')].some((b) => b.textContent === 'Make this copy the writer' && !b.disabled), null, { timeout: 20_000 });
    await make.click();
    await page.getByText("Writes pause for a few seconds; nothing is lost. wkr-1's copy then follows it as a standby.").first().waitFor({ timeout: 10_000 });
    await page.getByRole('button', { name: 'Make it the writer', exact: true }).click();
    await page.getByText("mgr-2's copy is the writer.").first().waitFor({ timeout: 20_000 });
    if (pageErrors.length > before) fail(`switch-over: ${pageErrors.slice(before).join(' | ')}`);
    else console.log("✓ switch-over: mgr-2's copy takes checkout's writes at Controls; the progress card walks to done");
  } catch (e) {
    fail(`switch-over: ${e instanceof Error ? e.message.split('\n')[0] : String(e)}`);
  }

  // Board 15: picking checkout's standby (the drag's keyboard twin) offers the switch-over first.
  try {
    const before = pageErrors.length;
    await page.goto(`${BASE}/data`, { waitUntil: 'networkidle' });
    await page.getByRole('button', { name: 'mgr-2: a standby copy. Make it the writer…' }).first().click();
    await page.getByText("Make mgr-2's copy the writer, then move?").first().waitFor({ timeout: 20_000 });
    await page.getByRole('button', { name: 'Make it the writer', exact: true }).waitFor({ timeout: 20_000 });
    if (pageErrors.length > before) fail(`board 15 switch-over: ${pageErrors.slice(before).join(' | ')}`);
    else console.log("✓ board 15: the writer's move is offered as making mgr-2's copy the writer");
  } catch (e) {
    fail(`board 15 switch-over: ${e instanceof Error ? e.message.split('\n')[0] : String(e)}`);
  }

  // A server at Controls: the Disks card renders (wkr-1's provider attached a blank volume).
  try {
    const before = pageErrors.length;
    await page.goto(`${BASE}/nodes/n-wkr-1`, { waitUntil: 'networkidle' });
    await page.getByRole('group', { name: 'Detail on this page' }).getByRole('button', { name: 'Controls' }).first().click();
    await page.getByRole('button', { name: 'Format and use' }).first().waitFor({ timeout: 10_000 });
    if (pageErrors.length > before) fail(`server controls: ${pageErrors.slice(before).join(' | ')}`);
    else console.log('✓ server controls: the Disks card offers wkr-1’s blank volume');
  } catch (e) {
    fail(`server controls: ${e instanceof Error ? e.message.split('\n')[0] : String(e)}`);
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
