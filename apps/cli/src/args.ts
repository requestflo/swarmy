/**
 * Argument parsing for `swarmy` — small, strict and dependency-free (the
 * binary must stay single-file). Each command declares its flags; unknown
 * flags are errors, not silently ignored. `--` ends flag parsing (everything
 * after it is positional, e.g. `swarmy run -- npm test --watch`).
 */

export type FlagType = 'boolean' | 'string' | 'list';

export interface FlagSpec {
  type: FlagType;
  short?: string;
  description: string;
  /** Placeholder shown in help (`--app <name>`). */
  value?: string;
}

export interface CommandSpec {
  name: string;
  /** `env pull` → ['env', 'pull'] is matched as name 'env pull'. */
  summary: string;
  usage: string;
  flags: Record<string, FlagSpec>;
  /** Stop flag parsing at the first positional (for `run <cmd> --its-own-flags`). */
  passthrough?: boolean;
}

export interface Parsed {
  command: string;
  positionals: string[];
  flags: Record<string, string | boolean | string[] | undefined>;
}

export class UsageError extends Error {}

/** Flags every command accepts. */
export const GLOBAL_FLAGS: Record<string, FlagSpec> = {
  help: { type: 'boolean', short: 'h', description: 'Show help' },
  controller: { type: 'string', value: 'url', description: 'Controller URL (default: the one you logged in to; env SWARMY_CONTROLLER)' },
  json: { type: 'boolean', description: 'Machine-readable JSON output' },
};

const APP_FLAGS: Record<string, FlagSpec> = {
  app: { type: 'string', short: 'a', value: 'name', description: 'App (name, repo id or org/repo; default: the linked app)' },
  environment: { type: 'string', short: 'e', value: 'env', description: 'Environment (default: production)' },
};
const SERVICE_FLAGS: Record<string, FlagSpec> = {
  ...APP_FLAGS,
  service: { type: 'string', short: 's', value: 'name', description: 'Service (default: the linked service, or the only one)' },
};

export const COMMANDS: CommandSpec[] = [
  {
    name: 'login',
    summary: 'Sign in (browser device flow, or an API key)',
    usage: 'swarmy login [--controller <url>] [--scope read,write,secrets.read] [--api-key <swk_…> | --with-token]',
    flags: {
      scope: { type: 'list', value: 'scopes', description: 'Scopes to request: read (default), write, secrets.read' },
      'api-key': { type: 'string', value: 'swk_…', description: 'Use an existing API key instead of the browser' },
      'with-token': { type: 'boolean', description: 'Read an API key from stdin' },
      'no-browser': { type: 'boolean', description: 'Print the URL instead of opening a browser' },
    },
  },
  { name: 'logout', summary: 'Forget the stored credential', usage: 'swarmy logout', flags: {} },
  { name: 'whoami', summary: 'Show who you are signed in as', usage: 'swarmy whoami', flags: {} },
  {
    name: 'link',
    summary: 'Link this directory to an app',
    usage: 'swarmy link [app] [--service <name>]',
    flags: { service: SERVICE_FLAGS.service!, environment: APP_FLAGS.environment! },
  },
  { name: 'unlink', summary: 'Remove this directory’s link', usage: 'swarmy unlink', flags: {} },
  {
    name: 'check',
    summary: 'Check locally that this repo will deploy on swarmy',
    usage: 'swarmy check [path] [--config <swarmy.yaml>]',
    flags: { config: { type: 'string', value: 'path', description: 'swarmy.yaml location if not at the root' } },
  },
  {
    name: 'deploy',
    summary: 'Deploy the linked app (plan + apply a branch head)',
    usage: 'swarmy deploy [--branch <b>] [--preview] [--app <name>]',
    flags: {
      ...APP_FLAGS,
      branch: { type: 'string', short: 'b', value: 'branch', description: 'Branch to deploy (default: the production branch; with --preview, the current branch)' },
      preview: { type: 'boolean', description: 'Deploy as a throwaway preview instead of production' },
    },
  },
  {
    name: 'logs',
    summary: 'Show (or follow) a service’s logs',
    usage: 'swarmy logs [service] [-f] [--tail <n>] [--since <30m>]',
    flags: {
      ...SERVICE_FLAGS,
      follow: { type: 'boolean', short: 'f', description: 'Keep streaming new lines' },
      tail: { type: 'string', short: 'n', value: 'n', description: 'Lines to show (default 200)' },
      since: { type: 'string', value: 'duration', description: 'Only lines newer than this (30s, 15m, 2h)' },
    },
  },
  {
    name: 'env pull',
    summary: 'Write a service’s env to a .env file (secrets withheld)',
    usage: 'swarmy env pull [file] [--include-secrets] [--service <name>]',
    flags: {
      ...SERVICE_FLAGS,
      'include-secrets': { type: 'boolean', description: 'Also write secret values (needs a key with the secrets.read scope; audited)' },
      force: { type: 'boolean', description: 'Overwrite an existing file' },
    },
  },
  {
    name: 'env push',
    summary: 'Push a .env file to a service (merge; rolling update)',
    usage: 'swarmy env push [file] [--secret KEY,…] [--prune] [--service <name>]',
    flags: {
      ...SERVICE_FLAGS,
      secret: { type: 'list', value: 'keys', description: 'Keys to store as secrets (write-only)' },
      prune: { type: 'boolean', description: 'Remove plain vars that are not in the file' },
      yes: { type: 'boolean', short: 'y', description: 'Do not ask for confirmation' },
    },
  },
  {
    name: 'env ls',
    summary: 'List a service’s env (secret values withheld)',
    usage: 'swarmy env ls [--service <name>]',
    flags: { ...SERVICE_FLAGS },
  },
  {
    name: 'run',
    summary: 'Run a local command with a service’s env',
    usage: 'swarmy run [--service <name>] [--include-secrets] -- <command> [args…]',
    flags: {
      ...SERVICE_FLAGS,
      'include-secrets': { type: 'boolean', description: 'Also inject secret values (secrets.read scope; audited)' },
    },
    passthrough: true,
  },
  {
    name: 'open',
    summary: 'Open the app (or its dashboard page) in the browser',
    usage: 'swarmy open [--dashboard] [--app <name>]',
    flags: { ...APP_FLAGS, dashboard: { type: 'boolean', description: 'Open the dashboard page instead of the app' } },
  },
  {
    name: 'status',
    summary: 'The linked app’s environments, services and last deploy',
    usage: 'swarmy status [--app <name>]',
    flags: { ...APP_FLAGS },
  },
  {
    name: 'sourcemaps upload',
    summary: 'Upload JS bundles + source maps for error tracking',
    usage: 'swarmy sourcemaps upload <dir|files…> [--app <stack>] [--release <ver> | --no-release] [--url-prefix ~/] [--ext js,map,mjs,cjs]',
    flags: {
      app: { type: 'string', short: 'a', value: 'app|stack', description: 'App or stack the errors belong to (default: the linked app)' },
      environment: APP_FLAGS.environment!,
      release: { type: 'string', short: 'r', value: 'version', description: 'Release (default: $SENTRY_RELEASE, then git rev-parse HEAD)' },
      'no-release': { type: 'boolean', description: 'Upload release-less (matched for every release; fine with debug ids)' },
      'url-prefix': { type: 'string', value: 'prefix', description: 'Prefix for artifact names (default ~/)' },
      ext: { type: 'list', value: 'exts', description: 'File extensions to include (default js,map,mjs,cjs)' },
    },
  },
  {
    name: 'errors dsn',
    summary: 'Print the error-tracking DSN of an app',
    usage: 'swarmy errors dsn [--app <app|stack>]',
    flags: { app: { type: 'string', short: 'a', value: 'app|stack', description: 'App or stack (default: the linked app)' }, environment: APP_FLAGS.environment! },
  },
  {
    name: 'errors rotate-key',
    summary: 'Rotate an app’s DSN key (the old key stops at once; redeploy to pick it up)',
    usage: 'swarmy errors rotate-key [--app <app|stack>] [--yes]',
    flags: {
      app: { type: 'string', short: 'a', value: 'app|stack', description: 'App or stack (default: the linked app)' },
      environment: APP_FLAGS.environment!,
      yes: { type: 'boolean', short: 'y', description: 'Do not ask for confirmation' },
    },
  },
  {
    name: 'remove',
    summary: 'Remove an app environment (its data is kept unless --delete-data)',
    usage: 'swarmy remove [--app <app|stack>] [--delete-data] [--yes]',
    flags: {
      app: { type: 'string', short: 'a', value: 'app|stack', description: 'App or stack (default: the linked app)' },
      environment: APP_FLAGS.environment!,
      'delete-data': { type: 'boolean', description: 'Also delete its data: volumes on every server and the passwords swarmy made for it' },
      yes: { type: 'boolean', short: 'y', description: 'Do not ask for the stack name to confirm' },
    },
  },
  {
    name: 'mcp',
    summary: 'Run the swarmy MCP server over stdio (for Claude Code, Cursor, …)',
    usage: 'swarmy mcp [--read-only]',
    flags: { 'read-only': { type: 'boolean', description: 'Never expose tools that change anything, even with a write key' } },
  },
  {
    name: 'explain',
    summary: 'Explain an error message (reads stdin when no text is given)',
    usage: 'swarmy explain [text…]',
    flags: {},
  },
  { name: 'version', summary: 'Print the version', usage: 'swarmy version', flags: {} },
  { name: 'help', summary: 'Show help', usage: 'swarmy help [command]', flags: {} },
];

const byName = new Map(COMMANDS.map((c) => [c.name, c]));

/** Resolve the command (one or two words) and the remaining argv. */
export function resolveCommand(argv: readonly string[]): { spec: CommandSpec; rest: string[] } {
  const [a, b, ...more] = argv;
  if (a === undefined || a === '-h' || a === '--help') return { spec: byName.get('help')!, rest: [] };
  if (a === '-v' || a === '--version') return { spec: byName.get('version')!, rest: [] };
  if (b !== undefined && byName.has(`${a} ${b}`)) return { spec: byName.get(`${a} ${b}`)!, rest: more };
  // `swarmy env` alone lists.
  if (a === 'env' && (b === undefined || b.startsWith('-'))) return { spec: byName.get('env ls')!, rest: argv.slice(1) };
  const spec = byName.get(a);
  if (!spec) {
    const near = COMMANDS.filter((c) => c.name.startsWith(a[0] ?? '')).map((c) => c.name);
    throw new UsageError(`unknown command "${a}"${near.length ? ` (did you mean ${near.join(', ')}?)` : ''} — see swarmy help`);
  }
  return { spec, rest: argv.slice(1) };
}

export function parseArgs(argv: readonly string[]): Parsed {
  const { spec, rest } = resolveCommand(argv);
  const specs: Record<string, FlagSpec> = { ...GLOBAL_FLAGS, ...spec.flags };
  const shorts = new Map<string, string>();
  for (const [name, f] of Object.entries(specs)) if (f.short) shorts.set(f.short, name);

  const flags: Parsed['flags'] = {};
  const positionals: string[] = [];
  const set = (name: string, f: FlagSpec, value: string | undefined) => {
    if (f.type === 'list') {
      const prev = (flags[name] as string[] | undefined) ?? [];
      flags[name] = [...prev, ...(value ?? '').split(',').map((s) => s.trim()).filter(Boolean)];
    } else {
      flags[name] = value;
    }
  };

  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]!;
    if (arg === '--') {
      positionals.push(...rest.slice(i + 1));
      break;
    }
    if (spec.passthrough && positionals.length > 0) {
      positionals.push(...rest.slice(i));
      break;
    }
    if (arg.startsWith('--')) {
      const eq = arg.indexOf('=');
      const rawName = eq > 0 ? arg.slice(2, eq) : arg.slice(2);
      const negated = rawName.startsWith('no-') && !specs[rawName] && specs[rawName.slice(3)]?.type === 'boolean';
      const name = negated ? rawName.slice(3) : rawName;
      const f = specs[name];
      if (!f) throw new UsageError(`unknown flag --${rawName} for "swarmy ${spec.name}" — see swarmy help ${spec.name}`);
      if (f.type === 'boolean') {
        if (eq > 0) throw new UsageError(`--${name} takes no value`);
        flags[name] = !negated;
      } else {
        const value = eq > 0 ? arg.slice(eq + 1) : rest[++i];
        if (value === undefined || (eq < 0 && value.startsWith('-') && value !== '-')) throw new UsageError(`--${name} needs a value`);
        set(name, f, value);
      }
      continue;
    }
    if (arg.startsWith('-') && arg.length > 1 && arg !== '-') {
      // -f, -fn 50, -n50
      const letters = arg.slice(1);
      for (let j = 0; j < letters.length; j++) {
        const name = shorts.get(letters[j]!);
        if (!name) throw new UsageError(`unknown flag -${letters[j]} for "swarmy ${spec.name}"`);
        const f = specs[name]!;
        if (f.type === 'boolean') {
          flags[name] = true;
          continue;
        }
        const inline = letters.slice(j + 1);
        const value = inline || rest[++i];
        if (value === undefined) throw new UsageError(`-${letters[j]} needs a value`);
        set(name, f, value);
        break;
      }
      continue;
    }
    positionals.push(arg);
  }
  return { command: spec.name, positionals, flags };
}

/** `30s` / `15m` / `2h` / `1d` → seconds. */
export function parseDurationSeconds(v: string): number {
  const m = /^(\d+)\s*(s|m|h|d)?$/.exec(v.trim());
  if (!m) throw new UsageError(`"${v}" is not a duration (e.g. 30s, 15m, 2h)`);
  const n = Number(m[1]);
  return n * ({ s: 1, m: 60, h: 3600, d: 86_400 } as const)[(m[2] ?? 's') as 's' | 'm' | 'h' | 'd'];
}

export function helpText(command?: string): string {
  const spec = command ? byName.get(command) : undefined;
  const fmtFlags = (flags: Record<string, FlagSpec>) =>
    Object.entries(flags).map(([name, f]) => {
      const left = `${f.short ? `-${f.short}, ` : '    '}--${name}${f.value ? ` <${f.value}>` : ''}`;
      return `  ${left.padEnd(30)} ${f.description}`;
    });
  if (spec) {
    return [`${spec.summary}`, '', `Usage: ${spec.usage}`, '', 'Flags:', ...fmtFlags({ ...spec.flags, ...GLOBAL_FLAGS })].join('\n');
  }
  return [
    'swarmy — deploy and run apps on your own swarm',
    '',
    'Usage: swarmy <command> [flags]',
    '',
    'Commands:',
    ...COMMANDS.filter((c) => c.name !== 'help').map((c) => `  ${c.name.padEnd(12)} ${c.summary}`),
    '',
    'Run `swarmy help <command>` for its flags.',
  ].join('\n');
}
