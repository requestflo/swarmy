import path from 'node:path';
import { checkRepo, createSwarmyMcpServer, explainError, formatCheckReport, formatExplanations, nodeRepoFs } from '@swarmy/devkit';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { CliError, VERSION, type Ctx } from '../context';

export async function check(ctx: Ctx): Promise<number> {
  const root = path.resolve(ctx.cwd, ctx.args.positionals[0] ?? '.');
  const config = ctx.flag<string>('config');
  const report = await checkRepo(nodeRepoFs(root), { name: path.basename(root), ...(config ? { configPath: config } : {}) });
  ctx.io.out(ctx.json ? JSON.stringify(report, null, 2) : formatCheckReport(report));
  return report.ok ? 0 : 1;
}

export async function explain(ctx: Ctx): Promise<number> {
  const text = ctx.args.positionals.length ? ctx.args.positionals.join(' ') : await ctx.io.stdin();
  if (!text.trim()) throw new CliError('paste an error: swarmy explain "<message>"  (or pipe logs into it)', 2);
  const found = explainError(text);
  ctx.io.out(ctx.json ? JSON.stringify(found, null, 2) : formatExplanations(found));
  return found.length ? 0 : 1;
}

/**
 * `swarmy mcp` — the MCP server over stdio. stdout belongs to the protocol:
 * everything human goes to stderr. Read-only unless the stored key has the
 * `write` scope (and --read-only is not set).
 */
export async function mcp(ctx: Ctx): Promise<void> {
  const client = await ctx.client();
  const cred = await ctx.credential();
  const me = await ctx.me().catch((e: unknown) => {
    throw new CliError(`cannot reach ${cred.controller}: ${e instanceof Error ? e.message : String(e)}`);
  });
  const readOnly = ctx.flag<boolean>('read-only') === true;
  ctx.io.err(
    `swarmy MCP server — ${cred.controller} as ${me.user.email ?? me.user.id} (${readOnly || !me.credential.scopes.includes('write') ? 'read-only' : 'read + write'})`,
  );
  const handle = serveStdio(() =>
    createSwarmyMcpServer({
      client,
      scopes: me.credential.scopes,
      transport: 'stdio',
      readOnly,
      cwd: ctx.cwd,
      version: VERSION,
      controllerUrl: cred.controller,
    }),
  );
  await new Promise<void>((resolve) => {
    process.stdin.once('end', resolve);
    process.once('SIGTERM', resolve);
    process.once('SIGINT', resolve);
  });
  await handle.close();
}
