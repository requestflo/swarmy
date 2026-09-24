import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { NotFoundError, appStack, resolveService, stackServices, type LogLine, type Service, type ServiceEnv } from '@swarmy/devkit';
import { parseDurationSeconds } from '../args';
import { CliError, type Ctx } from '../context';
import { parseDotenv, serializeDotenv } from '../dotenv';
import { environmentOf, targetApp } from './app';

/** The service a command targets: explicit, the link's default, or the app's only one. */
export async function targetService(ctx: Ctx, positional?: string): Promise<Service> {
  const client = await ctx.client();
  const explicit = positional ?? ctx.flag<string>('service') ?? (await ctx.link())?.service;
  let stack: string | undefined;
  if (ctx.flag<string>('app') || (await ctx.link())) {
    const app = await targetApp(ctx);
    stack = appStack(app, await environmentOf(ctx));
  }
  if (explicit) {
    try {
      return await resolveService(client, explicit, stack);
    } catch (e) {
      if (e instanceof NotFoundError) throw new CliError(e.message);
      throw e;
    }
  }
  if (!stack) throw new CliError('which service? pass --service <name>, or swarmy link an app first', 2);
  const services = await stackServices(client, stack);
  if (services.length === 1) return services[0]!;
  const web = services.find((s) => s.name === `${stack}_web`);
  if (web) return web;
  throw new CliError(
    services.length
      ? `${stack} has ${services.length} services — pick one with --service: ${services.map((s) => s.name.replace(`${stack}_`, '')).join(', ')}`
      : `${stack} has no services yet — deploy first`,
    2,
  );
}

function formatLine(l: LogLine): string {
  const ts = l.ts ? new Date(l.ts).toISOString().replace('T', ' ').replace('Z', '') : '';
  return `${ts ? `${ts} ` : ''}${l.stream === 'stderr' ? '! ' : ''}${l.message}`;
}

export async function logs(ctx: Ctx): Promise<void> {
  const client = await ctx.client();
  const svc = await targetService(ctx, ctx.args.positionals[0]);
  const tailRaw = ctx.flag<string>('tail');
  const tail = tailRaw === undefined ? undefined : Number(tailRaw);
  if (tail !== undefined && (!Number.isInteger(tail) || tail < 0)) throw new CliError('--tail must be a whole number');
  const sinceRaw = ctx.flag<string>('since');
  const since = sinceRaw ? Math.floor(Date.now() / 1000) - parseDurationSeconds(sinceRaw) : undefined;
  const print = (l: LogLine) => ctx.io.out(ctx.json ? JSON.stringify(l) : formatLine(l));
  const opts = { ...(tail !== undefined ? { tail } : {}), ...(since !== undefined ? { since } : {}) };

  if (!ctx.flag<boolean>('follow')) {
    const { data } = await client.services.logs(svc.id, opts);
    for (const l of data) print(l);
    return;
  }
  const ac = new AbortController();
  const stop = () => ac.abort();
  process.once('SIGINT', stop);
  try {
    for await (const l of client.services.followLogs(svc.id, { ...opts, signal: ac.signal })) print(l);
  } catch (e) {
    if (!ac.signal.aborted) throw e;
  } finally {
    process.off('SIGINT', stop);
  }
}

async function fetchEnv(ctx: Ctx, svc: Service, includeSecrets: boolean): Promise<ServiceEnv> {
  const client = await ctx.client();
  if (includeSecrets) {
    const me = await ctx.me();
    if (!me.credential.scopes.includes('secrets.read')) {
      throw new CliError('this key cannot read secrets — log in with: swarmy login --scope read,secrets.read (an admin approves)', 2);
    }
  }
  return client.services.env(svc.id, { revealSecrets: includeSecrets });
}

export async function envLs(ctx: Ctx): Promise<void> {
  const svc = await targetService(ctx);
  const env = await fetchEnv(ctx, svc, false);
  if (ctx.json) return ctx.io.out(JSON.stringify(env));
  ctx.io.out(`# ${env.service}`);
  for (const v of env.vars) {
    ctx.io.out(`${v.key}=${v.value ?? `<${v.secret ? 'secret' : 'withheld'}${v.delivery === 'file' ? ', file' : ''}>`}`);
  }
}

export async function envPull(ctx: Ctx): Promise<void> {
  const svc = await targetService(ctx);
  const include = ctx.flag<boolean>('include-secrets') === true;
  const env = await fetchEnv(ctx, svc, include);
  const file = path.resolve(ctx.cwd, ctx.args.positionals[0] ?? '.env');
  if (existsSync(file) && !ctx.flag<boolean>('force')) throw new CliError(`${path.relative(ctx.cwd, file)} exists — pass --force to overwrite`);
  const withheld = env.vars.filter((v) => v.value === null);
  const text = serializeDotenv(
    env.vars.map((v) => ({
      key: v.key,
      value: v.value,
      ...(v.value === null ? { note: v.error ? `could not read: ${v.error}` : 'secret — not written; use --include-secrets with a secrets.read key' } : {}),
    })),
    `Pulled from ${env.service} by swarmy env pull — ${new Date().toISOString()}${include ? '\nContains secret values: do not commit.' : ''}`,
  );
  // A file that may hold secrets is owner-only.
  await writeFile(file, text, { mode: 0o600 });
  if (ctx.json) return ctx.io.out(JSON.stringify({ file, written: env.vars.length - withheld.length, withheld: withheld.map((v) => v.key) }));
  ctx.io.out(`Wrote ${env.vars.length - withheld.length} variable(s) to ${path.relative(ctx.cwd, file)}.`);
  if (withheld.length) ctx.io.out(`Withheld (secret): ${withheld.map((v) => v.key).join(', ')}`);
}

export interface EnvPushPlan {
  set: Record<string, string>;
  secrets: Record<string, string>;
  unset: string[];
}

/** What `env push` will send, given the file and the service's current env. Pure. */
export function planEnvPush(local: Record<string, string>, remote: ServiceEnv, opts: { secretKeys: string[]; prune: boolean }): EnvPushPlan {
  const remoteSecret = new Set(remote.vars.filter((v) => v.delivery !== null).map((v) => v.key));
  const remoteValue = new Map(remote.vars.map((v) => [v.key, v.value]));
  const plan: EnvPushPlan = { set: {}, secrets: {}, unset: [] };
  for (const [k, v] of Object.entries(local)) {
    if (opts.secretKeys.includes(k) || remoteSecret.has(k)) plan.secrets[k] = v;
    else if (remoteValue.get(k) !== v) plan.set[k] = v;
  }
  if (opts.prune) {
    for (const v of remote.vars) if (v.delivery === null && !(v.key in local)) plan.unset.push(v.key);
  }
  return plan;
}

export async function envPush(ctx: Ctx): Promise<void> {
  const client = await ctx.client();
  const svc = await targetService(ctx);
  const file = path.resolve(ctx.cwd, ctx.args.positionals[0] ?? '.env');
  if (!existsSync(file)) throw new CliError(`${path.relative(ctx.cwd, file)} not found`);
  const local = parseDotenv(await readFile(file, 'utf8'));
  const remote = await client.services.env(svc.id);
  const plan = planEnvPush(local, remote, { secretKeys: ctx.flag<string[]>('secret') ?? [], prune: ctx.flag<boolean>('prune') === true });
  const n = Object.keys(plan.set).length + Object.keys(plan.secrets).length + plan.unset.length;
  if (!n) return ctx.io.out('Nothing to change.');
  const summary = [
    ...Object.keys(plan.set).map((k) => `  set     ${k}`),
    ...Object.keys(plan.secrets).map((k) => `  secret  ${k}`),
    ...plan.unset.map((k) => `  remove  ${k}`),
  ].join('\n');
  if (!ctx.flag<boolean>('yes') && !ctx.json) {
    ctx.io.err(`${svc.name} will roll out with:\n${summary}`);
    if (!ctx.io.isTty) throw new CliError('not a terminal — re-run with --yes to confirm', 2);
    const answer = prompt('Continue? [y/N]');
    if (!answer || !/^y(es)?$/i.test(answer.trim())) throw new CliError('cancelled', 1);
  }
  const r = await client.services.patchEnv(svc.id, {
    ...(Object.keys(plan.set).length ? { set: plan.set } : {}),
    ...(Object.keys(plan.secrets).length ? { secrets: plan.secrets } : {}),
    ...(plan.unset.length ? { unset: plan.unset } : {}),
  });
  if (ctx.json) return ctx.io.out(JSON.stringify(r));
  ctx.io.out(`Rolling out ${svc.name} (${r.changed.length} change(s)).`);
}

export async function run(ctx: Ctx): Promise<number> {
  const argv = ctx.args.positionals;
  if (!argv.length) throw new CliError('what should run? swarmy run -- <command> [args…]', 2);
  const svc = await targetService(ctx);
  const include = ctx.flag<boolean>('include-secrets') === true;
  const env = await fetchEnv(ctx, svc, include);
  const injected: Record<string, string> = {};
  for (const v of env.vars) if (v.value !== null) injected[v.key] = v.value;
  const missing = env.vars.filter((v) => v.value === null).map((v) => v.key);
  if (missing.length && !ctx.json) ctx.io.err(`swarmy run: ${env.service} env loaded; withheld secrets not set: ${missing.join(', ')}`);
  const bin = Bun.which(argv[0]!) ?? argv[0]!;
  const child = Bun.spawn([bin, ...argv.slice(1)], {
    cwd: ctx.cwd,
    env: { ...process.env, ...injected },
    stdin: 'inherit',
    stdout: 'inherit',
    stderr: 'inherit',
  });
  const forward = (sig: NodeJS.Signals) => child.kill(sig);
  process.on('SIGINT', forward);
  process.on('SIGTERM', forward);
  const code = await child.exited;
  process.off('SIGINT', forward);
  process.off('SIGTERM', forward);
  return code;
}
