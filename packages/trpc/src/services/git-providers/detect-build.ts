/**
 * Build detection for the "New app from Git" wizard — PURE.
 *
 * Reads the leading bytes of a handful of manifest files (git.inspect
 * `probePaths`, see inspect.ts) and says, before anything builds, how swarmy
 * will build the repo: "Detected: Next.js · Node 22 · start: npm run start",
 * with a suggested port and health path. It mirrors Railpack's provider order
 * (PHP → Go → Java → Rust → Ruby → Elixir → Python → Deno → Node → static)
 * closely enough to preview; the build itself runs `railpack prepare`, whose
 * answer is authoritative (it lands on the Build as `detected`).
 *
 * Files may be TRUNCATED (4 KB), so everything here is pattern-based — never
 * JSON.parse a probe.
 */

/** Probed per directory (content); all small manifests. */
export const DETECT_PROBE_FILES = [
  'Dockerfile',
  'railpack.json',
  'package.json',
  '.nvmrc',
  '.node-version',
  'deno.json',
  'go.mod',
  'Cargo.toml',
  'requirements.txt',
  'pyproject.toml',
  'Pipfile',
  '.python-version',
  'runtime.txt',
  'Gemfile',
  'composer.json',
  'mix.exs',
  'Procfile',
] as const;

/** Presence only (lockfiles and entrypoints; content is irrelevant or large). */
export const DETECT_PRESENCE_FILES = [
  'package-lock.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  'bun.lock',
  'bun.lockb',
  'uv.lock',
  'poetry.lock',
  'manage.py',
  'main.py',
  'app.py',
  'artisan',
  'index.php',
  'index.html',
  'public/index.html',
  'Staticfile',
  'pom.xml',
  'build.gradle',
  'build.gradle.kts',
] as const;

export interface BuildDetection {
  builder: 'dockerfile' | 'railpack';
  /** Railpack provider id (`node`, `python`, `golang`, …); absent for Dockerfile / unknown. */
  provider?: string;
  /** Human names. */
  language?: string;
  framework?: string;
  /** e.g. `Node 22`, `Python 3.12`, `Go 1.23`. */
  runtime?: string;
  packageManager?: string;
  /** The start command the image will get (best guess). */
  start?: string;
  /** Port the app will most likely listen on when PORT is unset. */
  port?: number;
  /** Suggested HTTP health path. */
  healthPath?: string;
  /** One line for the wizard: "Next.js · Node 22 · start: npm run start". */
  summary: string;
  /** Railpack found nothing to build; the build will fail without a Dockerfile or build.start. */
  unknown?: boolean;
}

/** Probe paths for a directory (`''` = repo root). */
export function detectProbePaths(dir: string): { probePaths: string[]; presencePaths: string[] } {
  const d = dir.replace(/^\.?\/*|\/+$/g, '');
  const at = (f: string) => (d ? `${d}/${f}` : f);
  return { probePaths: DETECT_PROBE_FILES.map(at), presencePaths: DETECT_PRESENCE_FILES.map(at) };
}

const has = (text: string | undefined, dep: string): boolean =>
  text !== undefined && new RegExp(`"${dep.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}"\\s*:`).test(text);

function majorOf(v: string | undefined): string | undefined {
  const m = v?.match(/(\d+(?:\.\d+)?)/);
  return m?.[1];
}

/** Node frameworks in priority order: [dependency, name, port, start-kind]. */
const NODE_FRAMEWORKS: Array<[string, string, number]> = [
  ['next', 'Next.js', 3000],
  ['nuxt', 'Nuxt', 3000],
  ['@remix-run/node', 'Remix', 3000],
  ['@react-router/node', 'React Router', 3000],
  ['@sveltejs/kit', 'SvelteKit', 3000],
  ['@nestjs/core', 'NestJS', 3000],
  ['astro', 'Astro', 4321],
  ['@tanstack/react-start', 'TanStack Start', 3000],
  ['hono', 'Hono', 3000],
  ['fastify', 'Fastify', 3000],
  ['koa', 'Koa', 3000],
  ['express', 'Express', 3000],
  ['vite', 'Vite', 80],
];

export function detectBuild(files: Record<string, string>, dir = ''): BuildDetection {
  const d = dir.replace(/^\.?\/*|\/+$/g, '');
  const get = (f: string): string | undefined => files[d ? `${d}/${f}` : f];
  const present = (f: string): boolean => get(f) !== undefined;
  const sum = (parts: Array<string | undefined>) => parts.filter(Boolean).join(' · ');

  if (present('Dockerfile')) {
    return { builder: 'dockerfile', summary: 'Dockerfile found — swarmy builds it as-is' };
  }

  const rp = (x: Omit<BuildDetection, 'builder' | 'summary'>): BuildDetection => ({
    builder: 'railpack',
    ...x,
    summary: sum([
      x.framework ?? x.language,
      x.runtime,
      x.start ? `start: ${x.start}` : undefined,
    ]),
  });
  const procfileWeb = get('Procfile')?.match(/^web:\s*(.+)$/m)?.[1]?.trim();

  // PHP
  if (present('composer.json') || present('index.php')) {
    const laravel = present('artisan') || has(get('composer.json'), 'laravel/framework');
    return rp({ provider: 'php', language: 'PHP', ...(laravel ? { framework: 'Laravel' } : {}), port: 80, healthPath: laravel ? '/up' : '/' });
  }
  // Go
  const goMod = get('go.mod');
  if (goMod !== undefined) {
    const v = goMod.match(/^go\s+(\d+\.\d+)/m)?.[1];
    return rp({ provider: 'golang', language: 'Go', ...(v ? { runtime: `Go ${v}` } : {}), start: procfileWeb ?? './out', port: 8080, healthPath: '/' });
  }
  // Java
  if (present('pom.xml') || present('build.gradle') || present('build.gradle.kts')) {
    return rp({ provider: 'java', language: 'Java', port: 8080, healthPath: '/' });
  }
  // Rust
  const cargo = get('Cargo.toml');
  if (cargo !== undefined) {
    const name = cargo.match(/^\s*name\s*=\s*"([^"]+)"/m)?.[1];
    return rp({ provider: 'rust', language: 'Rust', ...(name ? { start: `./bin/${name}` } : {}), port: 8080, healthPath: '/' });
  }
  // Ruby
  const gemfile = get('Gemfile');
  if (gemfile !== undefined) {
    const rails = /^\s*gem\s+['"]rails['"]/m.test(gemfile);
    const v = majorOf(gemfile.match(/^\s*ruby\s+['"]([^'"]+)['"]/m)?.[1]);
    return rp({
      provider: 'ruby',
      language: 'Ruby',
      ...(rails ? { framework: 'Rails' } : {}),
      ...(v ? { runtime: `Ruby ${v}` } : {}),
      ...(procfileWeb ? { start: procfileWeb } : rails ? { start: 'bundle exec rails server' } : {}),
      port: 3000,
      healthPath: rails ? '/up' : '/',
    });
  }
  // Elixir
  if (present('mix.exs')) {
    const phoenix = /:phoenix\b/.test(get('mix.exs') ?? '');
    return rp({ provider: 'elixir', language: 'Elixir', ...(phoenix ? { framework: 'Phoenix' } : {}), port: 4000, healthPath: '/' });
  }
  // Python
  const pyFiles = ['requirements.txt', 'pyproject.toml', 'Pipfile', 'uv.lock', 'poetry.lock'];
  if (pyFiles.some(present) || present('main.py') || present('app.py') || present('manage.py')) {
    const deps = [get('requirements.txt'), get('pyproject.toml'), get('Pipfile')].filter(Boolean).join('\n').toLowerCase();
    const dep = (n: string) => new RegExp(`(^|[\\s"'\\[,])${n}([\\s"'=<>~!\\[,;]|$)`, 'm').test(deps);
    const v = majorOf(get('.python-version') ?? get('runtime.txt')?.replace(/^python-/, ''));
    const pm = present('uv.lock') ? 'uv' : present('poetry.lock') ? 'poetry' : present('Pipfile') ? 'pipenv' : 'pip';
    const runtime = v ? `Python ${v}` : undefined;
    if (present('manage.py') || dep('django'))
      return rp({ provider: 'python', language: 'Python', framework: 'Django', runtime, packageManager: pm, start: procfileWeb ?? 'gunicorn <project>.wsgi', port: 8000, healthPath: '/' });
    if (dep('fastapi'))
      return rp({ provider: 'python', language: 'Python', framework: 'FastAPI', runtime, packageManager: pm, start: procfileWeb ?? 'uvicorn main:app', port: 8000, healthPath: '/docs' });
    if (dep('flask')) {
      const mod = present('main.py') ? 'main' : present('app.py') ? 'app' : 'main';
      return rp({ provider: 'python', language: 'Python', framework: 'Flask', runtime, packageManager: pm, start: procfileWeb ?? `gunicorn ${mod}:app`, port: 8000, healthPath: '/' });
    }
    return rp({
      provider: 'python',
      language: 'Python',
      runtime,
      packageManager: pm,
      ...(procfileWeb ? { start: procfileWeb } : present('main.py') ? { start: 'python main.py' } : {}),
      port: 8000,
      healthPath: '/',
    });
  }
  // Deno
  if (present('deno.json')) return rp({ provider: 'deno', language: 'Deno', port: 8000, healthPath: '/' });
  // Node
  const pkg = get('package.json');
  if (pkg !== undefined) {
    const pm = present('pnpm-lock.yaml') ? 'pnpm' : present('yarn.lock') ? 'yarn' : present('bun.lock') || present('bun.lockb') ? 'bun' : 'npm';
    const engine = pkg.match(/"engines"\s*:\s*\{[^}]*"node"\s*:\s*"([^"]+)"/)?.[1];
    const nodeV = majorOf(get('.nvmrc') ?? get('.node-version') ?? engine);
    const runtime = pm === 'bun' ? 'Bun' : nodeV ? `Node ${nodeV.split('.')[0]}` : 'Node';
    const hasStart = /"scripts"\s*:\s*\{[^}]*"start"\s*:/.test(pkg);
    const fw = NODE_FRAMEWORKS.find(([dep]) => has(pkg, dep));
    const run = pm === 'npm' ? 'npm run' : pm;
    // A frontend with no start script is served as static files by Caddy (port 80).
    const spa = fw && (fw[0] === 'vite' || fw[0] === 'astro') && !hasStart;
    return rp({
      provider: 'node',
      language: pm === 'bun' ? 'Bun' : 'Node.js',
      ...(fw ? { framework: fw[1] } : {}),
      runtime,
      packageManager: pm,
      ...(spa ? { start: 'caddy (static build)' } : hasStart ? { start: `${run} start` } : procfileWeb ? { start: procfileWeb } : {}),
      port: spa ? 80 : (fw?.[2] ?? 3000),
      healthPath: '/',
    });
  }
  // Static
  if (present('index.html') || present('public/index.html') || present('Staticfile')) {
    return rp({ provider: 'staticfile', language: 'Static site', framework: 'Static site', start: 'caddy', port: 80, healthPath: '/' });
  }
  return {
    builder: 'railpack',
    unknown: true,
    summary: 'No Dockerfile and nothing Railpack recognises — add a Dockerfile, or set build.start in swarmy.yaml',
  };
}
