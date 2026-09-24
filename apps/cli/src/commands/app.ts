import path from 'node:path';
import {
  appStack,
  checkRepo,
  NotFoundError,
  normalizeRepoUrl,
  nodeRepoFs,
  resolveApp,
  resolveService,
  stackServices,
  type App,
} from '@swarmy/devkit';
import { CliError, type Ctx } from '../context';
import { controllerKey } from '../credentials';
import { findRoot, gitInfo, removeLink, writeLink } from '../link';
import { openUrl } from '../open-url';

/** The app this command targets: --app, else the link, else the git remote. */
export async function targetApp(ctx: Ctx): Promise<App> {
  const client = await ctx.client();
  const ref = ctx.flag<string>('app') ?? (await ctx.link())?.repoId;
  if (ref) {
    try {
      return await resolveApp(client, ref);
    } catch (e) {
      if (e instanceof NotFoundError) throw new CliError(e.message);
      throw e;
    }
  }
  const { remote } = await gitInfo(ctx.cwd);
  if (remote) {
    const { data } = await client.apps.list();
    const hit = data.find((a) => normalizeRepoUrl(a.url) === normalizeRepoUrl(remote));
    if (hit) return hit;
  }
  throw new CliError('no app: run swarmy link (or pass --app <name>)', 2);
}

export async function environmentOf(ctx: Ctx): Promise<string> {
  return ctx.flag<string>('environment') ?? (await ctx.link())?.environment ?? 'production';
}

export async function link(ctx: Ctx): Promise<void> {
  const client = await ctx.client();
  const cred = await ctx.credential();
  const { data } = await client.apps.list();
  const ref = ctx.args.positionals[0];
  let app: App | undefined;
  if (ref) {
    app = await resolveApp(client, ref).catch((e: unknown) => {
      throw new CliError(e instanceof Error ? e.message : String(e));
    });
  } else {
    const { remote } = await gitInfo(ctx.cwd);
    if (remote) app = data.find((a) => normalizeRepoUrl(a.url) === normalizeRepoUrl(remote));
    if (!app) {
      const names = data.map((a) => `  ${a.app_name ?? a.full_name ?? a.repo_id}  (${a.full_name ?? a.url})`).join('\n');
      throw new CliError(
        `${remote ? `no app for ${remote}` : 'not a git checkout'} — pass one: swarmy link <app>${names ? `\n\nApps:\n${names}` : '\n\nNo apps yet: connect the repo in the dashboard (CI → Apps).'}`,
        2,
      );
    }
  }
  const environment = ctx.flag<string>('environment');
  const service = ctx.flag<string>('service');
  if (environment) appStack(app, environment);
  if (service) await resolveService(client, service, appStack(app, environment));
  const { root } = await findRoot(ctx.cwd);
  const file = await writeLink(root, {
    controller: controllerKey(cred.controller),
    repoId: app.repo_id,
    app: app.app_name ?? app.full_name ?? app.repo_id,
    ...(environment ? { environment } : {}),
    ...(service ? { service } : {}),
  });
  if (ctx.json) return ctx.io.out(JSON.stringify({ linked: app.repo_id, file }));
  ctx.io.out(`Linked ${path.relative(ctx.cwd, root) || '.'} → ${app.app_name ?? app.full_name} (${app.full_name ?? app.url}).`);
}

export async function unlink(ctx: Ctx): Promise<void> {
  ctx.io.out((await removeLink(ctx.cwd)) ? 'Unlinked.' : 'This directory is not linked.');
}

export async function deploy(ctx: Ctx): Promise<void> {
  const client = await ctx.client();
  const app = await targetApp(ctx);
  const name = app.app_name ?? app.full_name ?? app.repo_id;
  if (ctx.flag<boolean>('preview')) {
    const branch = ctx.flag<string>('branch') ?? (await gitInfo(ctx.cwd)).branch;
    if (!branch) throw new CliError('which branch? swarmy deploy --preview --branch <b>');
    ctx.io.err(`Building ${branch} of ${name} as a preview… (push it first — swarmy builds from git)`);
    const r = await client.apps.preview(app.repo_id, branch);
    if (ctx.json) return ctx.io.out(JSON.stringify(r));
    if (r.action !== 'deployed') throw new CliError(`preview ${r.action}: ${r.reason ?? 'no reason given'}`);
    return ctx.io.out(`Preview ${r.stack} is up${r.url ? `: ${r.url}` : ''}.`);
  }
  const branch = ctx.flag<string>('branch');
  ctx.io.err(`Deploying ${name}${branch ? ` @ ${branch}` : ''}…`);
  const r = await client.apps.deploy(app.repo_id, branch ? { branch } : {});
  if (ctx.json) return ctx.io.out(JSON.stringify(r));
  if (r.plan?.markdown) ctx.io.out(r.plan.markdown.trim());
  const held = r.plan?.actions.filter((a) => a.gate === 'confirm' && a.outcome !== 'done') ?? [];
  const errors = r.plan?.issues.filter((i) => i.severity === 'error') ?? [];
  ctx.io.out('');
  if (errors.length) {
    for (const i of errors) ctx.io.out(`error ${i.path}${i.line ? `:${i.line}` : ''} ${i.message}`);
    throw new CliError('swarmy.yaml has errors — nothing was deployed (run swarmy check)');
  }
  ctx.io.out(`${r.status}${r.stack ? ` → stack ${r.stack}` : ''}${r.reason ? ` (${r.reason})` : ''}`);
  if (held.length) ctx.io.out(`${held.length} step(s) wait for confirmation in the dashboard: ${held.map((a) => a.id).join(', ')}`);
}

export async function status(ctx: Ctx): Promise<void> {
  const client = await ctx.client();
  const app = await targetApp(ctx);
  const rows = await Promise.all(
    app.environments.map(async (e) => ({ env: e, services: await stackServices(client, e.stack) })),
  );
  if (ctx.json) return ctx.io.out(JSON.stringify({ app, environments: rows.map((r) => ({ ...r.env, services: r.services })) }));
  const out: string[] = [`${app.app_name ?? app.full_name}  ${app.full_name ?? app.url}  (branch ${app.branch})`];
  for (const { env, services } of rows) {
    const drift = app.drift?.environments.find((d) => d.environment === env.environment)?.changes;
    out.push(
      '',
      `${env.environment} → ${env.stack}   last deploy: ${env.latest_plan_status ?? 'never'}${env.latest_sha ? ` @ ${env.latest_sha.slice(0, 7)}` : ''}${env.latest_created_at ? ` (${env.latest_created_at})` : ''}${drift ? `   drift: ${drift} change(s)` : ''}`,
    );
    for (const s of services) {
      const ok = s.replicas.running >= s.replicas.desired;
      out.push(`  ${ok ? '●' : '○'} ${s.name.padEnd(28)} ${`${s.replicas.running}/${s.replicas.desired}`.padEnd(6)} ${s.status}`);
    }
    if (!services.length) out.push('  (no services running)');
  }
  if (app.previews.length) {
    out.push('', 'previews:');
    for (const p of app.previews) out.push(`  #${p.pr}  ${p.status.padEnd(10)} ${p.url ?? p.stack}`);
  }
  ctx.io.out(out.join('\n'));
}

export async function open(ctx: Ctx): Promise<void> {
  const cred = await ctx.credential();
  const app = await targetApp(ctx);
  const env = await environmentOf(ctx);
  const stack = appStack(app, env);
  let url = `${cred.controller}/stacks/${encodeURIComponent(stack)}`;
  if (!ctx.flag<boolean>('dashboard')) {
    // The app's public URL comes from the checkout's swarmy.yaml domains.
    const { root } = await findRoot(ctx.cwd);
    const report = await checkRepo(nodeRepoFs(root));
    const route = report.routes.find((r) => !r.host.startsWith('*.'));
    if (route) url = `https://${route.host}${route.path === '/' ? '' : route.path}`;
  }
  if (ctx.json) return ctx.io.out(JSON.stringify({ url }));
  ctx.io.out(url);
  await openUrl(url);
}
