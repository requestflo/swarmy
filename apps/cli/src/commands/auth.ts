import { hostname } from 'node:os';
import { SwarmyClient, SwarmyApiError } from '@swarmy/devkit';
import { controllerKey, deleteCredential, loadConfig, saveConfig, saveCredential } from '../credentials';
import { CliError, VERSION, type Ctx } from '../context';
import { openUrl } from '../open-url';

interface DeviceCode {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete: string;
  expires_in: number;
  interval: number;
}

const DEVICE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code';

/** RFC 8628 device flow against the controller; resolves to an `swk_…` key. */
export async function deviceLogin(
  ctx: Ctx,
  controller: string,
  scopes: string[],
  deps: { fetch?: typeof fetch; sleep?: (ms: number) => Promise<void>; open?: (url: string) => Promise<boolean> } = {},
): Promise<{ key: string; scopes: string[] }> {
  const f = deps.fetch ?? fetch;
  const sleep = deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const res = await f(`${controller}/api/cli/device/code`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'user-agent': `swarmy-cli/${VERSION}` },
    body: JSON.stringify({ client_name: 'swarmy CLI', hostname: hostname(), scope: scopes.join(' ') }),
  }).catch((e: unknown) => {
    throw new CliError(`cannot reach ${controller}: ${e instanceof Error ? e.message : String(e)}`);
  });
  if (!res.ok) throw new CliError(`${controller} did not start a login (HTTP ${res.status}) — is this a swarmy controller?`);
  const code = (await res.json()) as DeviceCode;

  ctx.io.err(`\nTo sign in, open:\n\n  ${code.verification_uri_complete}\n\nand confirm the code  ${code.user_code}\n`);
  if (!ctx.flag<boolean>('no-browser')) await (deps.open ?? openUrl)(code.verification_uri_complete);
  ctx.io.err('Waiting for approval…');

  let interval = Math.max(1, code.interval) * 1000;
  const deadline = Date.now() + code.expires_in * 1000;
  while (Date.now() < deadline) {
    await sleep(interval);
    const t = await f(`${controller}/api/cli/device/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ grant_type: DEVICE_GRANT, device_code: code.device_code }),
    });
    const body = (await t.json().catch(() => ({}))) as { access_token?: string; scope?: string; error?: string };
    if (t.ok && body.access_token) return { key: body.access_token, scopes: (body.scope ?? 'read').split(' ') };
    if (body.error === 'authorization_pending') continue;
    if (body.error === 'slow_down') {
      interval += 5000;
      continue;
    }
    if (body.error === 'access_denied') throw new CliError('login was denied in the browser');
    if (body.error === 'expired_token') break;
    throw new CliError(`login failed: ${body.error ?? `HTTP ${t.status}`}`);
  }
  throw new CliError('the login code expired — run swarmy login again');
}

export async function login(ctx: Ctx): Promise<void> {
  const controllerArg = (await ctx.controller()) ?? undefined;
  if (!controllerArg) throw new CliError('which controller? swarmy login --controller https://swarm.example.com', 2);
  const controller = controllerKey(controllerArg);
  const scopes = ctx.flag<string[]>('scope') ?? ['read'];

  let key = ctx.flag<string>('api-key');
  if (ctx.flag<boolean>('with-token')) key = (await ctx.io.stdin()).trim();
  if (!key) key = (await deviceLogin(ctx, controller, scopes)).key;
  if (!key.startsWith('swk_')) throw new CliError('that does not look like a swarmy API key (swk_…)');

  // Prove it works before storing it.
  let me;
  try {
    me = await new SwarmyClient({ endpoint: controller, apiKey: key }).me();
  } catch (e) {
    if (e instanceof SwarmyApiError && e.status === 401) throw new CliError('the controller rejected that key');
    throw e;
  }
  const store = await saveCredential(controller, key);
  const cfg = await loadConfig();
  await saveConfig({
    ...cfg,
    controller,
    profiles: { ...(cfg.profiles ?? {}), [controller]: { email: me.user.email, org: me.org_id, scopes: me.credential.scopes, store } },
  });
  const where = store === 'keychain' ? 'the macOS keychain' : store === 'secret-service' ? 'the system keyring' : 'a private file (mode 600)';
  if (ctx.json) ctx.io.out(JSON.stringify({ controller, user: me.user, role: me.role, scopes: me.credential.scopes, store }));
  else ctx.io.out(`Logged in to ${controller} as ${me.user.email ?? me.user.id} (${me.role}; scopes: ${me.credential.scopes.join(', ')}). Key stored in ${where}.`);
}

export async function logout(ctx: Ctx): Promise<void> {
  const controller = await ctx.controller();
  if (!controller) throw new CliError('not logged in');
  await deleteCredential(controller);
  const cfg = await loadConfig();
  const profiles = { ...(cfg.profiles ?? {}) };
  delete profiles[controllerKey(controller)];
  await saveConfig({ ...cfg, profiles, ...(cfg.controller === controllerKey(controller) ? { controller: undefined } : {}) });
  ctx.io.out(`Logged out of ${controllerKey(controller)}. (The key still exists on the controller until revoked in Settings → API keys.)`);
}

export async function whoami(ctx: Ctx): Promise<void> {
  const me = await ctx.me();
  const cred = await ctx.credential();
  if (ctx.json) return ctx.io.out(JSON.stringify({ controller: cred.controller, ...me }));
  ctx.io.out(
    [
      `controller  ${cred.controller}`,
      `user        ${me.user.email ?? me.user.id}${me.user.name ? ` (${me.user.name})` : ''}`,
      `org         ${me.org_id}`,
      `role        ${me.role}`,
      `scopes      ${me.credential.scopes.join(', ')}`,
      `credential  ${me.credential.kind} ${me.credential.id} (from ${cred.source})`,
    ].join('\n'),
  );
}
