#!/usr/bin/env bun
/**
 * `swarmy` — the developer CLI. Every remote command speaks the public REST
 * API through the TypeScript SDK with an org-scoped API key; `check` and
 * `explain` run entirely locally; `mcp` serves the same abilities to AI
 * tools over stdio.
 */
import { SwarmyApiError } from '@swarmy/devkit';
import { helpText, parseArgs, UsageError } from './args';
import { CliError, makeCtx, processIo, VERSION, type Ctx, type Io } from './context';
import { login, logout, whoami } from './commands/auth';
import { deploy, link, open, status, unlink } from './commands/app';
import { envLs, envPull, envPush, logs, run as runCmd } from './commands/service';
import { check, explain, mcp } from './commands/local';
import { errorsDsn, errorsRotateKey, sourcemapsUpload } from './commands/errors';
import { remove } from './commands/stack';

type Handler = (ctx: Ctx) => Promise<number | void>;

const HANDLERS: Record<string, Handler> = {
  login,
  logout,
  whoami,
  link,
  unlink,
  check,
  deploy,
  logs,
  'env ls': envLs,
  'env pull': envPull,
  'env push': envPush,
  run: runCmd,
  open,
  status,
  mcp,
  remove,
  explain,
  'sourcemaps upload': sourcemapsUpload,
  'errors dsn': errorsDsn,
  'errors rotate-key': errorsRotateKey,
  version: async (ctx) => ctx.io.out(ctx.json ? JSON.stringify({ version: VERSION }) : `swarmy ${VERSION}`),
  help: async (ctx) => ctx.io.out(helpText(ctx.args.positionals.join(' ') || undefined)),
};

export async function main(argv: string[], io: Io = processIo, cwd = process.cwd()): Promise<number> {
  let ctx: Ctx | undefined;
  try {
    const args = parseArgs(argv);
    ctx = makeCtx(args, io, cwd);
    if (args.flags.help) {
      io.out(helpText(args.command));
      return 0;
    }
    const code = await HANDLERS[args.command]!(ctx);
    return typeof code === 'number' ? code : 0;
  } catch (e) {
    if (e instanceof UsageError) {
      io.err(`swarmy: ${e.message}`);
      return 2;
    }
    if (e instanceof CliError) {
      io.err(`swarmy: ${e.message}`);
      return e.exitCode;
    }
    if (e instanceof SwarmyApiError) {
      const p = e.problem;
      io.err(`swarmy: ${p.detail ?? p.title} (HTTP ${e.status}${p.swarmy_code ? `, ${p.swarmy_code}` : ''})`);
      if (e.status === 401) io.err('Your key was revoked or expired — run swarmy login.');
      if (e.status === 403) io.err('Not allowed with this key — a write key needs: swarmy login --scope read,write');
      return e.status === 401 || e.status === 403 ? 3 : 1;
    }
    io.err(`swarmy: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }
}

if (import.meta.main) {
  process.exit(await main(process.argv.slice(2)));
}
