/**
 * Name resolution shared by the CLI and the MCP tools: people and models say
 * "orders" or "web", the API speaks ids.
 */
import type { App, Service, Stack, SwarmyClient } from './sdk';

export class NotFoundError extends Error {}

/** An app by repo id, app name, repo full name (`org/repo`) or URL. */
export async function resolveApp(client: SwarmyClient, ref: string): Promise<App> {
  const { data } = await client.apps.list();
  const norm = (u: string) => normalizeRepoUrl(u);
  const hit =
    data.find((a) => a.repo_id === ref || a.app_name === ref || a.full_name === ref) ??
    data.find((a) => norm(a.url) === norm(ref));
  if (!hit) {
    const known = data.map((a) => a.app_name ?? a.full_name ?? a.repo_id).join(', ') || 'none';
    throw new NotFoundError(`no app "${ref}" (known: ${known})`);
  }
  return hit;
}

/** `git@github.com:org/repo.git`, `https://github.com/org/repo` → `github.com/org/repo`. */
export function normalizeRepoUrl(url: string): string {
  return url
    .trim()
    .replace(/^[a-z+]+:\/\//i, '')
    .replace(/^[^@/]+@/, '')
    .replace(/:(?!\d+\/)/, '/')
    .replace(/\.git$/, '')
    .replace(/\/+$/, '')
    .toLowerCase();
}

/** The stack an app's environment deploys to (default: production). */
export function appStack(app: App, environment = 'production'): string {
  const env = app.environments.find((e) => e.environment === environment);
  if (!env) {
    throw new NotFoundError(
      `app ${app.app_name ?? app.repo_id} has no environment "${environment}" (has: ${app.environments.map((e) => e.environment).join(', ')})`,
    );
  }
  return env.stack;
}

/** A stack by id or name (the REST API addresses stacks by id). */
export async function resolveStack(client: SwarmyClient, ref: string): Promise<Stack> {
  let cursor: string | undefined;
  const seen: string[] = [];
  for (;;) {
    const page = await client.stacks.list(cursor ? { cursor } : undefined);
    const hit = page.data.find((s) => s.id === ref || s.name === ref);
    if (hit) return hit;
    seen.push(...page.data.map((s) => s.name));
    if (!page.next_cursor) break;
    cursor = page.next_cursor;
  }
  throw new NotFoundError(`no stack "${ref}" (known: ${seen.join(', ') || 'none'})`);
}

/** Services of a stack (by `stack_id`, which is the stack name for Docker-truth stacks). */
export async function stackServices(client: SwarmyClient, stack: string): Promise<Service[]> {
  const { data } = await client.services.list();
  return data.filter((s) => s.stack_id === stack || s.name.startsWith(`${stack}_`));
}

/**
 * A service by id, full name (`shop_web`), or short name within `stack`
 * (`web`). Ambiguous short names are an error naming the candidates.
 */
export async function resolveService(client: SwarmyClient, ref: string, stack?: string): Promise<Service> {
  const { data } = await client.services.list();
  const exact = data.find((s) => s.id === ref || s.name === ref);
  if (exact) return exact;
  const scoped = stack ? data.filter((s) => s.stack_id === stack || s.name.startsWith(`${stack}_`)) : data;
  const short = scoped.filter((s) => s.name === `${s.stack_id}_${ref}` || s.name.endsWith(`_${ref}`));
  if (short.length === 1) return short[0]!;
  if (short.length > 1) throw new NotFoundError(`"${ref}" is ambiguous: ${short.map((s) => s.name).join(', ')}`);
  throw new NotFoundError(`no service "${ref}"${stack ? ` in ${stack}` : ''}`);
}
