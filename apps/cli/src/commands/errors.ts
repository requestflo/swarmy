/**
 * Error tracking from the CLI: the DSN, key rotation, and source-map upload
 * (the Sentry-compatible artifact endpoint on the controller,
 * `POST /errors/v1/stacks/{stack}/releases/{release|_}/files`).
 */
import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { appStack, NotFoundError, resolveApp } from '@swarmy/devkit';
import { CliError, VERSION, type Ctx } from '../context';

/** Per-file cap on the controller; requests are batched under it too. */
export const MAX_UPLOAD_BYTES = 15 * 1024 * 1024;
const MAX_FILES_PER_REQUEST = 50;
const DEFAULT_EXTS = ['js', 'map', 'mjs', 'cjs'];

/** `--app` may name an app (→ its environment's stack) or a stack directly; default: the linked app. */
export async function targetStack(ctx: Ctx): Promise<string> {
  const client = await ctx.client();
  const env = ctx.flag<string>('environment') ?? (await ctx.link())?.environment;
  const ref = ctx.flag<string>('app') ?? (await ctx.link())?.repoId;
  if (!ref) throw new CliError('which app? pass --app <app|stack>, or swarmy link first', 2);
  try {
    return appStack(await resolveApp(client, ref), env);
  } catch (e) {
    if (e instanceof NotFoundError && ctx.flag<string>('app')) return ref; // a plain stack name
    throw e instanceof NotFoundError ? new CliError(e.message) : e;
  }
}

export async function errorsDsn(ctx: Ctx): Promise<void> {
  const stack = await targetStack(ctx);
  const s = await (await ctx.client()).stacks.errors(stack);
  if (ctx.json) return ctx.io.out(JSON.stringify(s));
  if (!s.project) throw new CliError(`error tracking is off for ${stack} — turn it on in the dashboard (the app’s Errors tab)`);
  ctx.io.out(s.project.dsn);
  if (!s.enabled) ctx.io.err(`note: error tracking is not enabled for ${stack}, so apps are not given SENTRY_DSN`);
  if (!s.store_enabled) ctx.io.err('note: the observability store is off — events are dropped until it is on');
  if (s.pending_redeploy.length) ctx.io.err(`note: redeploy to deliver the DSN to: ${s.pending_redeploy.join(', ')}`);
}

export async function errorsRotateKey(ctx: Ctx): Promise<void> {
  const stack = await targetStack(ctx);
  if (!ctx.flag<boolean>('yes') && !ctx.json) {
    if (!ctx.io.isTty) throw new CliError('not a terminal — re-run with --yes to confirm', 2);
    const answer = prompt(`Rotate the DSN key of ${stack}? The old key stops working immediately. [y/N]`);
    if (!answer || !/^y(es)?$/i.test(answer.trim())) throw new CliError('cancelled');
  }
  const p = await (await ctx.client()).stacks.rotateErrorsKey(stack);
  if (ctx.json) return ctx.io.out(JSON.stringify(p));
  ctx.io.out(p.dsn);
  ctx.io.err(`Rotated. Redeploy ${stack} so its services receive the new SENTRY_DSN.`);
}

export interface Artifact {
  /** Artifact name the error pipeline matches (`~/static/app.js.map`). */
  name: string;
  file: string;
  size: number;
}

async function walk(dir: string, exts: Set<string>, out: string[]): Promise<void> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) await walk(p, exts, out);
    else if (entry.isFile() && exts.has(path.extname(entry.name).slice(1))) out.push(p);
  }
}

/** Collect artifacts: dirs are walked (names relative to the dir), files are named relative to cwd. */
export async function collectArtifacts(
  inputs: string[],
  opts: { cwd: string; urlPrefix: string; exts: string[] },
): Promise<Artifact[]> {
  const exts = new Set(opts.exts.map((e) => e.replace(/^\./, '')));
  const out: Artifact[] = [];
  const seen = new Set<string>();
  for (const input of inputs) {
    const abs = path.resolve(opts.cwd, input);
    const st = await stat(abs).catch(() => null);
    if (!st) throw new CliError(`${input}: no such file or directory`);
    const files: Array<{ file: string; rel: string }> = [];
    if (st.isDirectory()) {
      const found: string[] = [];
      await walk(abs, exts, found);
      for (const f of found) files.push({ file: f, rel: path.relative(abs, f) });
    } else {
      files.push({ file: abs, rel: path.relative(opts.cwd, abs) });
    }
    for (const { file, rel } of files.sort((a, b) => a.rel.localeCompare(b.rel))) {
      if (seen.has(file)) continue;
      seen.add(file);
      const name = `${opts.urlPrefix}${rel.split(path.sep).join('/')}`;
      out.push({ name, file, size: (await stat(file)).size });
    }
  }
  return out;
}

/** Group artifacts into requests under the size and count caps. Oversized files are returned apart. */
export function batchArtifacts(list: Artifact[], maxBytes = MAX_UPLOAD_BYTES): { batches: Artifact[][]; tooBig: Artifact[] } {
  const batches: Artifact[][] = [];
  const tooBig: Artifact[] = [];
  let cur: Artifact[] = [];
  let bytes = 0;
  for (const a of list) {
    if (a.size > maxBytes) {
      tooBig.push(a);
      continue;
    }
    if (cur.length && (bytes + a.size > maxBytes || cur.length >= MAX_FILES_PER_REQUEST)) {
      batches.push(cur);
      cur = [];
      bytes = 0;
    }
    cur.push(a);
    bytes += a.size;
  }
  if (cur.length) batches.push(cur);
  return { batches, tooBig };
}

async function gitHead(cwd: string): Promise<string | null> {
  try {
    const p = Bun.spawn(['git', 'rev-parse', 'HEAD'], { cwd, stdout: 'pipe', stderr: 'ignore' });
    const out = (await new Response(p.stdout).text()).trim();
    return (await p.exited) === 0 && out ? out : null;
  } catch {
    return null;
  }
}

export async function sourcemapsUpload(ctx: Ctx): Promise<number> {
  const inputs = ctx.args.positionals;
  if (!inputs.length) throw new CliError('what to upload? swarmy sourcemaps upload ./dist', 2);
  const noRelease = ctx.flag<boolean>('no-release') === true;
  if (noRelease && ctx.flag<string>('release')) throw new CliError('--release and --no-release are exclusive', 2);
  const release = noRelease
    ? '_'
    : (ctx.flag<string>('release') ?? process.env.SENTRY_RELEASE ?? (await gitHead(ctx.cwd)) ?? null);
  if (!release) throw new CliError('which release? pass --release <version> (or --no-release)', 2);

  const cred = await ctx.credential();
  const stack = await targetStack(ctx);
  const artifacts = await collectArtifacts(inputs, {
    cwd: ctx.cwd,
    urlPrefix: ctx.flag<string>('url-prefix') ?? '~/',
    exts: ctx.flag<string[]>('ext') ?? DEFAULT_EXTS,
  });
  if (!artifacts.length) throw new CliError('no .js/.map files found');
  const { batches, tooBig } = batchArtifacts(artifacts);
  for (const a of tooBig) ctx.io.err(`skipping ${a.name}: larger than 15 MB`);

  const url = `${cred.controller}/errors/v1/stacks/${encodeURIComponent(stack)}/releases/${encodeURIComponent(release)}/files`;
  const stored: Array<{ name: string; kind: string; debugId: string | null; size: number }> = [];
  for (const batch of batches) {
    const form = new FormData();
    for (const a of batch) form.append(a.name, Bun.file(a.file), path.basename(a.file));
    const res = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${cred.apiKey}`, 'user-agent': `swarmy-cli/${VERSION}` },
      body: form,
    });
    const body = (await res.json().catch(() => ({}))) as { stored?: typeof stored; detail?: string };
    if (res.status !== 201) {
      throw new CliError(`upload failed (HTTP ${res.status}): ${body.detail ?? res.statusText}${stored.length ? ` — ${stored.length} file(s) were stored before this` : ''}`, res.status === 401 || res.status === 403 ? 3 : 1);
    }
    stored.push(...(body.stored ?? []));
  }
  if (ctx.json) {
    ctx.io.out(JSON.stringify({ stack, release: release === '_' ? null : release, stored }));
  } else {
    for (const s of stored) ctx.io.out(`${s.kind.padEnd(10)} ${s.name}${s.debugId ? `  (debug id ${s.debugId})` : ''}`);
    ctx.io.out(`Uploaded ${stored.length} file(s) to ${stack} for ${release === '_' ? 'every release' : `release ${release}`}.`);
  }
  return tooBig.length ? 1 : 0;
}

