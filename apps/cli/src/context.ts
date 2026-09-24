import { SwarmyClient, type Principal } from '@swarmy/devkit';
import { loadConfig, loadCredential, type Credential } from './credentials';
import { readLink, type LinkFile } from './link';
import type { Parsed } from './args';

export class CliError extends Error {
  constructor(
    message: string,
    readonly exitCode = 1,
  ) {
    super(message);
  }
}

export interface Io {
  out: (s: string) => void;
  err: (s: string) => void;
  /** stdin as text (for --with-token / explain). */
  stdin: () => Promise<string>;
  isTty: boolean;
}

export const processIo: Io = {
  out: (s) => process.stdout.write(`${s}\n`),
  err: (s) => process.stderr.write(`${s}\n`),
  stdin: () => new Response(Bun.stdin.stream()).text(),
  isTty: Boolean(process.stdout.isTTY),
};

export interface Ctx {
  args: Parsed;
  io: Io;
  cwd: string;
  json: boolean;
  flag: <T = string>(name: string) => T | undefined;
  /** The controller URL: --controller, env, link, config. */
  controller: () => Promise<string | null>;
  credential: () => Promise<Credential>;
  client: () => Promise<SwarmyClient>;
  me: () => Promise<Principal>;
  link: () => Promise<LinkFile | null>;
}

export function makeCtx(args: Parsed, io: Io, cwd = process.cwd()): Ctx {
  let cred: Promise<Credential> | undefined;
  let client: Promise<SwarmyClient> | undefined;
  let me: Promise<Principal> | undefined;
  let link: Promise<LinkFile | null> | undefined;
  const ctx: Ctx = {
    args,
    io,
    cwd,
    json: args.flags.json === true,
    flag: <T>(name: string) => args.flags[name] as T | undefined,
    link: () => (link ??= readLink(cwd)),
    controller: async () =>
      (args.flags.controller as string | undefined) ??
      process.env.SWARMY_CONTROLLER ??
      (await ctx.link())?.controller ??
      (await loadConfig()).controller ??
      null,
    credential: () =>
      (cred ??= (async () => {
        const controller = await ctx.controller();
        const c = await loadCredential(controller ? { controller } : {});
        if (!c) {
          throw new CliError(
            controller ? `not logged in to ${controller} — run: swarmy login --controller ${controller}` : 'not logged in — run: swarmy login --controller <url>',
            2,
          );
        }
        return c;
      })()),
    client: () =>
      (client ??= (async () => {
        const c = await ctx.credential();
        return new SwarmyClient({ endpoint: c.controller, apiKey: c.apiKey, headers: { 'user-agent': `swarmy-cli/${VERSION}` } });
      })()),
    me: () => (me ??= ctx.client().then((c) => c.me())),
  };
  return ctx;
}

export const VERSION: string = process.env.SWARMY_CLI_VERSION ?? '0.0.0-dev';
