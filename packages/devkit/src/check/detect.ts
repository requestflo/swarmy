/**
 * "What is this?" — basic, local stack detection for directories without a
 * Dockerfile, i.e. the ones swarmy builds with Railpack.
 *
 * This mirrors Railpack's provider order closely enough to answer "will this
 * build?" before anything leaves the laptop. It is deliberately a SEAM: when
 * the Railpack builder integration lands (developer-platform epic §1), swap
 * `detectStack` for its plan output and keep the `StackDetection` shape.
 */
import { joinRel, type RepoFs } from './fs';

export type Provider =
  | 'node'
  | 'deno'
  | 'python'
  | 'go'
  | 'ruby'
  | 'php'
  | 'rust'
  | 'java'
  | 'elixir'
  | 'staticfile';

export interface StackDetection {
  provider: Provider;
  /** Display name of the language/runtime ("Node", "Python"). */
  language: string;
  /** Framework when recognisable ("Next.js", "Django"). */
  framework?: string;
  /** Runtime version the build would pin ("22", "3.12"). */
  version?: string;
  packageManager?: string;
  /** The command the container would start with, when we can tell. */
  startCommand?: string;
  /** The port the framework listens on by default. */
  port?: number;
  /** Files that led to the decision, for the report. */
  evidence: string[];
  /** Things that will likely break the build or the start. */
  warnings: string[];
}

/** "Node 22 · Next.js" */
export function describeDetection(d: StackDetection): string {
  const lang = d.version ? `${d.language} ${d.version}` : d.language;
  return d.framework ? `${lang} · ${d.framework}` : lang;
}

interface PackageJson {
  name?: string;
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  engines?: { node?: string };
  packageManager?: string;
  main?: string;
}

const NODE_FRAMEWORKS: Array<{ dep: string; name: string; port: number }> = [
  { dep: 'next', name: 'Next.js', port: 3000 },
  { dep: 'nuxt', name: 'Nuxt', port: 3000 },
  { dep: '@remix-run/node', name: 'Remix', port: 3000 },
  { dep: '@react-router/node', name: 'React Router', port: 3000 },
  { dep: '@sveltejs/kit', name: 'SvelteKit', port: 3000 },
  { dep: 'astro', name: 'Astro', port: 4321 },
  { dep: '@tanstack/react-start', name: 'TanStack Start', port: 3000 },
  { dep: '@nestjs/core', name: 'NestJS', port: 3000 },
  { dep: 'hono', name: 'Hono', port: 3000 },
  { dep: 'fastify', name: 'Fastify', port: 3000 },
  { dep: 'express', name: 'Express', port: 3000 },
  { dep: 'vite', name: 'Vite', port: 80 },
];

/** First major version in a semver range ("^20.11" / ">=18" / "v22.3.0" → "20" / "18" / "22"). */
export function majorOf(range: string | undefined | null): string | undefined {
  const m = /(\d+)(?:\.(\d+))?/.exec((range ?? '').trim());
  return m ? m[1] : undefined;
}

function parseJson<T>(text: string | null): T | null {
  if (!text) return null;
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

async function firstLine(fs: RepoFs, file: string): Promise<string | undefined> {
  const t = await fs.read(file);
  const line = t?.split('\n').map((l) => l.trim()).find(Boolean);
  return line || undefined;
}

async function detectNode(fs: RepoFs, dir: string, entries: Set<string>): Promise<StackDetection | null> {
  if (!entries.has('package.json')) return null;
  const evidence = ['package.json'];
  const warnings: string[] = [];
  const pkg = parseJson<PackageJson>(await fs.read(joinRel(dir, 'package.json')));
  if (!pkg) {
    return {
      provider: 'node',
      language: 'Node',
      evidence,
      warnings: ['package.json is not valid JSON — the build will fail'],
    };
  }
  const deps = { ...(pkg.devDependencies ?? {}), ...(pkg.dependencies ?? {}) };
  const fw = NODE_FRAMEWORKS.find((f) => f.dep in deps);

  let packageManager = 'npm';
  if (entries.has('bun.lock') || entries.has('bun.lockb')) packageManager = 'bun';
  else if (entries.has('pnpm-lock.yaml')) packageManager = 'pnpm';
  else if (entries.has('yarn.lock')) packageManager = 'yarn';
  else if (pkg.packageManager) packageManager = pkg.packageManager.split('@')[0] || 'npm';
  const lock = ['bun.lock', 'bun.lockb', 'pnpm-lock.yaml', 'yarn.lock', 'package-lock.json'].find((l) => entries.has(l));
  if (lock) evidence.push(lock);
  else warnings.push('no lockfile — installs are not reproducible (commit package-lock.json, pnpm-lock.yaml, yarn.lock or bun.lock)');

  let version = majorOf(pkg.engines?.node);
  if (version) evidence.push('package.json engines.node');
  for (const f of ['.nvmrc', '.node-version']) {
    if (!version && entries.has(f)) {
      version = majorOf(await firstLine(fs, joinRel(dir, f)));
      if (version) evidence.push(f);
    }
  }

  const scripts = pkg.scripts ?? {};
  const run = packageManager === 'npm' ? 'npm run' : packageManager;
  let startCommand: string | undefined;
  if (scripts.start) startCommand = `${run} start`;
  else if (pkg.main) startCommand = `node ${pkg.main}`;
  else if (entries.has('server.js')) startCommand = 'node server.js';
  else if (entries.has('index.js')) startCommand = 'node index.js';

  const isStaticVite = fw?.name === 'Vite' && !scripts.start;
  if (!startCommand && !isStaticVite) {
    warnings.push('no "start" script — add one to package.json so the container knows how to run');
  }
  if (fw && fw.name !== 'Vite' && !scripts.build && ['Next.js', 'Nuxt', 'Remix', 'SvelteKit', 'Astro'].includes(fw.name)) {
    warnings.push(`${fw.name} needs a "build" script in package.json`);
  }

  return {
    provider: 'node',
    language: packageManager === 'bun' && !version ? 'Bun' : 'Node',
    ...(fw ? { framework: isStaticVite ? 'Vite (static)' : fw.name } : {}),
    ...(version ? { version } : {}),
    packageManager,
    ...(startCommand ? { startCommand } : {}),
    ...(fw ? { port: fw.port } : {}),
    evidence,
    warnings,
  };
}

async function detectPython(fs: RepoFs, dir: string, entries: Set<string>): Promise<StackDetection | null> {
  const manifests = ['pyproject.toml', 'requirements.txt', 'Pipfile', 'setup.py', 'uv.lock', 'poetry.lock'].filter((f) =>
    entries.has(f),
  );
  if (!manifests.length) return null;
  const warnings: string[] = [];
  const text = (
    await Promise.all(['pyproject.toml', 'requirements.txt', 'Pipfile'].map((f) => fs.read(joinRel(dir, f))))
  )
    .filter(Boolean)
    .join('\n')
    .toLowerCase();
  let framework: string | undefined;
  let port: number | undefined;
  let startCommand: string | undefined;
  if (entries.has('manage.py') || /\bdjango\b/.test(text)) {
    framework = 'Django';
    port = 8000;
    if (!/\bgunicorn\b/.test(text)) warnings.push('Django without gunicorn — add it so the container serves with a production server');
  } else if (/\bfastapi\b/.test(text)) {
    framework = 'FastAPI';
    port = 8000;
    if (!/\buvicorn\b/.test(text)) warnings.push('FastAPI without uvicorn — add it to run the app');
  } else if (/\bflask\b/.test(text)) {
    framework = 'Flask';
    port = 5000;
  }
  if (entries.has('main.py')) startCommand = 'python main.py';
  else if (entries.has('app.py')) startCommand = 'python app.py';
  if (entries.has('Procfile')) startCommand = 'Procfile web';
  let version: string | undefined;
  if (entries.has('.python-version')) version = (await firstLine(fs, joinRel(dir, '.python-version')))?.split('.').slice(0, 2).join('.');
  else if (entries.has('runtime.txt')) version = /(\d+\.\d+)/.exec((await firstLine(fs, joinRel(dir, 'runtime.txt'))) ?? '')?.[1];
  return {
    provider: 'python',
    language: 'Python',
    ...(framework ? { framework } : {}),
    ...(version ? { version } : {}),
    ...(startCommand ? { startCommand } : {}),
    ...(port ? { port } : {}),
    evidence: manifests,
    warnings,
  };
}

async function detectGo(fs: RepoFs, dir: string, entries: Set<string>): Promise<StackDetection | null> {
  if (!entries.has('go.mod')) return null;
  const mod = (await fs.read(joinRel(dir, 'go.mod'))) ?? '';
  const version = /^go\s+(\d+\.\d+)/m.exec(mod)?.[1];
  const framework = /github\.com\/gin-gonic\/gin/.test(mod)
    ? 'Gin'
    : /github\.com\/labstack\/echo/.test(mod)
      ? 'Echo'
      : /github\.com\/gofiber\/fiber/.test(mod)
        ? 'Fiber'
        : undefined;
  return {
    provider: 'go',
    language: 'Go',
    ...(framework ? { framework } : {}),
    ...(version ? { version } : {}),
    port: 8080,
    evidence: ['go.mod'],
    warnings: entries.has('main.go') || entries.has('cmd') ? [] : ['no main.go or cmd/ — Railpack may not find the binary to build'],
  };
}

const simple = (
  provider: Provider,
  language: string,
  file: string,
  extra: Partial<StackDetection> = {},
): StackDetection => ({ provider, language, evidence: [file], warnings: [], ...extra });

/**
 * Detect the stack in `dir` (repo-relative, '' = root). Null = nothing Railpack
 * would recognise — the service needs a Dockerfile or an image.
 */
export async function detectStack(fs: RepoFs, dir = ''): Promise<StackDetection | null> {
  const entries = new Set(await fs.list(dir));
  if (!entries.size) return null;

  if (entries.has('deno.json') || entries.has('deno.jsonc')) {
    return simple('deno', 'Deno', entries.has('deno.json') ? 'deno.json' : 'deno.jsonc', { port: 8000 });
  }
  const node = await detectNode(fs, dir, entries);
  if (node) return node;
  const py = await detectPython(fs, dir, entries);
  if (py) return py;
  const go = await detectGo(fs, dir, entries);
  if (go) return go;
  if (entries.has('Gemfile')) {
    const rails = entries.has('config') && (await fs.exists(joinRel(dir, 'config/application.rb')));
    return simple('ruby', 'Ruby', 'Gemfile', rails ? { framework: 'Rails', port: 3000 } : {});
  }
  if (entries.has('composer.json')) {
    return simple('php', 'PHP', 'composer.json', entries.has('artisan') ? { framework: 'Laravel', port: 80 } : { port: 80 });
  }
  if (entries.has('Cargo.toml')) return simple('rust', 'Rust', 'Cargo.toml', { port: 8080 });
  for (const f of ['pom.xml', 'build.gradle', 'build.gradle.kts']) {
    if (entries.has(f)) return simple('java', 'Java', f, { port: 8080 });
  }
  if (entries.has('mix.exs')) {
    const phoenix = /:phoenix\b/.test((await fs.read(joinRel(dir, 'mix.exs'))) ?? '');
    return simple('elixir', 'Elixir', 'mix.exs', phoenix ? { framework: 'Phoenix', port: 4000 } : {});
  }
  if (entries.has('index.html') || entries.has('Staticfile')) {
    return simple('staticfile', 'Static site', entries.has('Staticfile') ? 'Staticfile' : 'index.html', { port: 80 });
  }
  return null;
}
