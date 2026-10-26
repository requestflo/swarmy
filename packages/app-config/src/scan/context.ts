/**
 * One pass over the scanned files → the facts detectors ask about: every
 * dependency (npm, pip, gem, go, composer) with its line, package.json
 * scripts, dotenv entries, env vars the code reads, Procfile processes, the
 * compose file's services, and a grep over the source lines.
 */
import { COMPOSE_FILES, composeServices, type ComposeService } from './compose-facts';
import { at, envEntries, ev, isSourcePath, jsonEntries, procfileEntries } from './files';
import type { Evidence, ScanFile } from './types';

export interface Fact {
  name: string;
  value: string;
  ev: Evidence;
}

export interface ScanCtx {
  dir: string;
  file(name: string): ScanFile | undefined;
  /** Scanned, or known present (lockfiles, manage.py). */
  has(name: string): boolean;
  deps: Fact[];
  dep(...names: string[]): Fact | undefined;
  scripts: Fact[];
  /** Entries of the folder's .env.example (and friends), and the environment of compose services it builds. */
  dotenv: Fact[];
  /** The folder's compose file, service by service (empty without one). */
  compose: ComposeService[];
  /** Env vars the code and config read (`process.env.X`, `env("X")`, `os.environ["X"]`). */
  reads: Fact[];
  procfile: Fact[];
  /** Source lines matching `re` (value = the first capture group, if any). */
  grep(re: RegExp): Fact[];
  /** The first line of the folder's `name` matching `re`. */
  find(name: string, re: RegExp): Fact | undefined;
  /** `npm run x` / `pnpm run x` / `yarn run x` / `bun run x`. */
  run(script: string): string;
}

const DOTENV = ['.env.example', '.env.sample', '.env.template', '.env.dist'];
const READ_RE =
  /(?:process\.env\.|process\.env\[['"]|Bun\.env\.|import\.meta\.env\.|environ(?:\.get)?\(?\[?['"]|getenv\(['"]|ENV(?:\.fetch\()?\[?['"]|\benv\(['"])([A-Z][A-Z0-9_]*)/g;

function depsOf(f: ScanFile, kind: string): Fact[] {
  const fact = (name: string, value: string, l: ScanFile['lines'][number]): Fact => ({ name: name.toLowerCase(), value, ev: ev(f, l) });
  if (kind === 'package.json' || kind === 'composer.json') {
    const sections = kind === 'package.json' ? /^(dependencies|devDependencies|optionalDependencies|peerDependencies)$/ : /^require(-dev)?$/;
    return jsonEntries(f)
      .filter((e) => e.path.length === 1 && sections.test(e.path[0]!))
      .map((e) => fact(e.key, e.value, e.line));
  }
  const out: Fact[] = [];
  let section = '';
  for (const l of f.lines) {
    const t = l.text;
    const head = /^\s*\[([^\]]+)\]/.exec(t);
    if (head) section = head[1]!.toLowerCase();
    let m: RegExpExecArray | null = null;
    if (kind === 'requirements.txt') m = /^\s*([A-Za-z][A-Za-z0-9_.-]*)/.exec(t.replace(/#.*/, ''));
    else if (kind === 'Gemfile') m = /^\s*gem\s+['"]([^'"]+)['"]/.exec(t);
    else if (kind === 'go.mod') m = /^\s*(?:require\s+)?([a-z0-9.-]+\.[a-z]+\/\S+)\s+v\d/.exec(t);
    else if (kind === 'pyproject.toml' || kind === 'Pipfile') {
      m = /^\s*"([A-Za-z][A-Za-z0-9_.-]*)\s*(?:[[<>=~!;,"]|$)/.exec(t);
      if (!m && (section.includes('dependencies') || section.includes('packages'))) m = /^\s*([A-Za-z][A-Za-z0-9_.-]*)\s*=/.exec(t);
    }
    if (m) out.push(fact(m[1]!.replace(/_/g, '-'), '', l));
  }
  return out;
}

export function buildCtx(files: ScanFile[], dir: string, present: readonly string[] = []): ScanCtx {
  const byPath = new Map(files.map((f) => [f.path, f]));
  const file = (name: string) => byPath.get(at(dir, name));
  const known = new Set([...files.map((f) => f.path), ...present]);
  const deps = ['package.json', 'requirements.txt', 'pyproject.toml', 'Pipfile', 'Gemfile', 'go.mod', 'composer.json'].flatMap((k) => {
    const f = file(k);
    return f ? depsOf(f, k) : [];
  });
  const pkg = file('package.json');
  const scripts = pkg
    ? jsonEntries(pkg)
        .filter((e) => e.path.length === 1 && e.path[0] === 'scripts')
        .map((e) => ({ name: e.key, value: e.value, ev: ev(pkg, e.line) }))
    : [];
  const dotenv = DOTENV.flatMap((n) => {
    const f = file(n);
    return f ? envEntries(f).map((e) => ({ name: e.name, value: e.value, ev: ev(f, e.line) })) : [];
  });
  const composeFile = COMPOSE_FILES.map((n) => file(n)).find(Boolean);
  const compose = composeFile ? composeServices(composeFile) : [];
  dotenv.push(...compose.filter((s) => s.build).flatMap((s) => s.env));
  const proc = file('Procfile');
  const procfile = proc ? procfileEntries(proc).map((e) => ({ name: e.name, value: e.value, ev: ev(proc, e.line) })) : [];
  const sources = files.filter((f) => isSourcePath(f.path, dir));
  const hits = (f: ScanFile, re: RegExp): Fact[] =>
    f.lines.flatMap((l) => {
      const m = re.exec(l.text);
      return m ? [{ name: '', value: m[1] ?? m[0], ev: ev(f, l) }] : [];
    });
  const grep = (re: RegExp): Fact[] => sources.flatMap((f) => hits(f, re));
  const reads: Fact[] = [];
  for (const f of [...sources, ...['prisma/schema.prisma', 'drizzle.config.ts', 'drizzle.config.js'].flatMap((n) => file(n) ?? [])]) {
    for (const l of f.lines) for (const m of l.text.matchAll(READ_RE)) reads.push({ name: m[1]!, value: '', ev: ev(f, l) });
  }
  const pm = known.has(at(dir, 'pnpm-lock.yaml'))
    ? 'pnpm'
    : known.has(at(dir, 'yarn.lock'))
      ? 'yarn'
      : known.has(at(dir, 'bun.lock')) || known.has(at(dir, 'bun.lockb'))
        ? 'bun'
        : 'npm';
  return {
    dir,
    file,
    has: (name) => known.has(at(dir, name)),
    deps,
    dep: (...names) => deps.find((d) => names.includes(d.name)),
    scripts,
    dotenv,
    compose,
    reads,
    procfile,
    grep,
    find: (name, re) => {
      const f = file(name);
      return f ? hits(f, re)[0] : undefined;
    },
    run: (script) => `${pm} run ${script}`,
  };
}
