import type { DemoStore, DomainResolvers } from '../types';

/**
 * Demo resolvers for the CI/CD + registry surfaces (router `cicd`) and the Docker
 * Hub autocomplete proxy (router `images`).
 *
 * The CI page links git repos, builds an image on a builder node, pushes to an
 * in-swarm `registry:2` service, and tails the build log live. With no backend we
 * keep repos / builds / registry config / GC policy / build-log scrollback in
 * `store.extra['cicd']` and project them into the exact view shapes the dashboard
 * reads (see packages/trpc/src/services/cicd.service.ts → GitRepoView, BuildView,
 * RegistryConfigView, GcPolicyView, BuildLogLine). `images` returns a small,
 * believable static Docker Hub-shaped result so the service builder autocomplete
 * works offline.
 */

// ── View shapes (mirror cicd.service.ts / images.service.ts) ─────────────────

type GitProvider = 'github' | 'gitlab';

interface GitRepoView {
  id: string;
  provider: GitProvider;
  url: string;
  branch: string;
  autodeploy: boolean;
  serviceId: string | null;
  hasToken: boolean;
  createdAt: string;
}

interface BuildView {
  id: string;
  repoId: string;
  repoUrl: string;
  commit: string | null;
  status: string;
  image: string | null;
  logsRef: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  builder: string | null;
  detected: {
    version?: string;
    providers: string[];
    packages: Record<string, string>;
    metadata: Record<string, string>;
    startCommand?: string;
  } | null;
  cachedSteps: number | null;
}

interface RegistryConfigView {
  enabled: boolean;
  host: string | null;
  hasCreds: boolean;
  username: string | null;
  login: 'auto-generated' | 'custom' | null;
  authEnforced: boolean;
  online: boolean;
  updatedAt: string;
}

interface GcPolicyView {
  mode: 'on-healthcheck' | 'age-days';
  keepProd: boolean;
  days: number | null;
  cacheMaxAgeDays: number;
  cacheMaxGb: number;
}

interface BuildLogLine {
  seq: number;
  stream: 'stdout' | 'stderr';
  message: string;
}

interface ImageSuggestion {
  name: string;
  source: 'local' | 'hub';
  description: string;
  official: boolean;
  stars: number;
}

interface TagSuggestion {
  name: string;
  updatedAt?: string;
}

/** Per-build canned log script, replayed by the page query and the subscription. */
interface BuildLog {
  lines: BuildLogLine[];
}

/** Everything CI/CD owns in the demo store. */
interface CicdState {
  repos: GitRepoView[];
  builds: BuildView[];
  logs: Record<string, BuildLog>;
  registry: RegistryConfigView;
  gc: GcPolicyView;
  /** Docker Hub login of the pull-through cache (username only); absent = anonymous. */
  cacheUsername?: string | null;
}

/** Mirrors `RegistryCacheView` (system-images.service). */
interface RegistryCacheView {
  username: string | null;
  applied: boolean;
  deployed: boolean;
}

const REGISTRY_HOST = 'localhost:5000';

const now = Date.now();
const iso = (msAgo: number): string => new Date(now - msAgo).toISOString();
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

const rid = (prefix: string): string => `${prefix}-${Math.random().toString(36).slice(2, 10)}`;
/** Deterministic 8-char id for seeded rows, so `/ci/build-…` deep links survive a reload. */
const stableHash = (key: string, len: number, radix: number): string => {
  let h = 2166136261;
  for (const c of key) h = Math.imul(h ^ c.charCodeAt(0), 16777619) >>> 0;
  let out = '';
  for (let i = 0; out.length < len; i++) out += (Math.imul(h, 2 * i + 1) >>> 0).toString(radix);
  return out.slice(0, len);
};
const stableId = (prefix: string, key: string): string => `${prefix}-${stableHash(key, 8, 36)}`;

/** Read (or lazily init) the CI/CD slice of the store. */
function state(store: DemoStore): CicdState {
  const existing = store.extra['cicd'] as CicdState | undefined;
  if (existing) return existing;
  const fresh = buildSeed();
  store.extra['cicd'] = fresh;
  return fresh;
}

/** A short, realistic Docker-style build log keyed to an image ref. */
function makeBuildLog(image: string, ok: boolean): BuildLog {
  const stdout: string[] = [
    'Cloning repository…',
    'Resolving deltas: 100% (842/842), done.',
    'Step 1/9 : FROM node:20-alpine',
    'Step 2/9 : WORKDIR /app',
    'Step 3/9 : COPY package.json bun.lockb ./',
    'Step 4/9 : RUN bun install --frozen-lockfile',
    ' ---> Installed 318 packages in 4.21s',
    'Step 5/9 : COPY . .',
    'Step 6/9 : RUN bun run build',
    ' ---> Compiled successfully in 11.8s',
    'Step 7/9 : EXPOSE 3000',
    'Step 8/9 : CMD ["bun", "start"]',
    'Step 9/9 : LABEL org.swarmy.build=true',
  ];
  const tail = ok
    ? [
        `Successfully built ${image.split('@')[1]?.slice(0, 19) ?? 'sha256:8f3c1a'}`,
        `Pushing to ${REGISTRY_HOST}…`,
        'latest: digest: sha256:8f3c1a92… size: 4096',
        'Build succeeded.',
      ]
    : [];
  const lines: BuildLogLine[] = [];
  let seq = 0;
  for (const m of [...stdout, ...tail]) lines.push({ seq: seq++, stream: 'stdout', message: m });
  if (!ok) {
    lines.push({ seq: 0, stream: 'stderr', message: 'error: command "bun run build" exited with code 1' });
    lines.push({ seq: 1, stream: 'stderr', message: 'src/index.ts(42,7): TS2345: Type mismatch.' });
  }
  return { lines };
}

/** The seed CI/CD world — repos linked to the demo cluster's services, recent builds. */
function buildSeed(): CicdState {
  const repos: GitRepoView[] = [
    {
      id: 'repo-web',
      provider: 'github',
      url: 'https://github.com/northwind/web.git',
      branch: 'main',
      autodeploy: true,
      serviceId: 'svc-web',
      hasToken: true,
      createdAt: iso(40 * DAY),
    },
    {
      id: 'repo-api',
      provider: 'github',
      url: 'https://github.com/northwind/api.git',
      branch: 'main',
      autodeploy: true,
      serviceId: 'svc-api',
      hasToken: true,
      createdAt: iso(40 * DAY),
    },
    {
      id: 'repo-checkout',
      provider: 'gitlab',
      url: 'https://gitlab.com/northwind/checkout.git',
      branch: 'release',
      autodeploy: false,
      serviceId: 'svc-checkout',
      hasToken: true,
      createdAt: iso(18 * DAY),
    },
    {
      id: 'repo-worker',
      provider: 'github',
      url: 'https://github.com/northwind/worker.git',
      branch: 'main',
      autodeploy: false,
      serviceId: null,
      hasToken: false,
      createdAt: iso(9 * DAY),
    },
  ];

  const builds: BuildView[] = [
    build('repo-api', repos, 'succeeded', 'northwind-api', '2.4.0', 12 * MIN, 9 * MIN),
    build('repo-web', repos, 'succeeded', 'northwind-web', '1.8.2', 2 * HOUR, 2 * HOUR - 3 * MIN),
    build('repo-checkout', repos, 'failed', 'northwind-checkout', 'release', 35 * MIN, 33 * MIN),
    build('repo-web', repos, 'succeeded', 'northwind-web', '1.8.1', 6 * HOUR, 6 * HOUR - 2 * MIN),
    build('repo-api', repos, 'building', 'northwind-api', 'main', 40_000, null),
    build('repo-worker', repos, 'succeeded', 'northwind-worker', '2.4.0', 1 * DAY, 1 * DAY - 4 * MIN),
  ];

  const logs: Record<string, BuildLog> = {};
  for (const b of builds) {
    if (b.logsRef) logs[b.logsRef] = makeBuildLog(b.image ?? '', b.status !== 'failed');
  }

  return {
    repos,
    builds,
    logs,
    registry: {
      enabled: true,
      host: REGISTRY_HOST,
      hasCreds: true,
      username: 'swarmy',
      login: 'auto-generated',
      authEnforced: true,
      online: true,
      updatedAt: iso(3 * DAY),
    },
    gc: { mode: 'on-healthcheck', keepProd: true, days: null, cacheMaxAgeDays: 14, cacheMaxGb: 20 },
  };
}

function build(
  repoId: string,
  repos: GitRepoView[],
  status: string,
  imageName: string,
  ref: string,
  startedMsAgo: number,
  finishedMsAgo: number | null,
): BuildView {
  const repo = repos.find((r) => r.id === repoId);
  const key = `${repoId}/${imageName}/${ref}/${status}/${startedMsAgo}`;
  const sha = `sha256:${stableHash(key, 14, 16)}`;
  const image =
    status === 'failed' ? `${REGISTRY_HOST}/${imageName}:${ref}` : `${REGISTRY_HOST}/${imageName}@${sha}`;
  const logsRef = stableId('log', key);
  return {
    id: stableId('build', key),
    repoId,
    repoUrl: repo?.url ?? '',
    commit: ref,
    status,
    image,
    logsRef,
    startedAt: iso(startedMsAgo),
    finishedAt: finishedMsAgo === null ? null : iso(finishedMsAgo),
    // The web app has no Dockerfile: Railpack builds it (zero-config), warm from the registry cache.
    ...(imageName === 'northwind-web' && status === 'succeeded'
      ? {
          builder: 'railpack',
          detected: {
            version: '0.40.0',
            providers: ['node'],
            packages: { node: '22.23.2' },
            metadata: { nodePackageManager: 'pnpm' },
            startCommand: 'pnpm start',
          },
          cachedSteps: 14,
        }
      : { builder: status === 'succeeded' ? 'dockerfile' : null, detected: null, cachedSteps: status === 'succeeded' ? 6 : null }),
  };
}

// ── Static Docker Hub autocomplete data ───────────────────────────────────────

const HUB_IMAGES: ImageSuggestion[] = ([
  { name: 'nginx', description: 'Official build of Nginx.', official: true, stars: 19800 },
  { name: 'redis', description: 'Redis is an open source key-value store.', official: true, stars: 12700 },
  { name: 'postgres', description: 'The PostgreSQL object-relational database.', official: true, stars: 13500 },
  { name: 'node', description: 'Node.js is a JavaScript runtime.', official: true, stars: 13200 },
  { name: 'mysql', description: 'MySQL is a widely used relational database.', official: true, stars: 15100 },
  { name: 'traefik', description: 'The cloud native application proxy.', official: true, stars: 3400 },
  { name: 'grafana/grafana', description: 'The open observability platform.', official: false, stars: 4100 },
  { name: 'prom/prometheus', description: 'The Prometheus monitoring system.', official: false, stars: 2600 },
  { name: 'caddy', description: 'Fast, multi-platform web server with automatic HTTPS.', official: true, stars: 1900 },
  { name: 'alpine', description: 'A minimal Docker image based on Alpine Linux.', official: true, stars: 11000 },
] as Omit<ImageSuggestion, 'source'>[]).map((img) => ({ ...img, source: 'hub' as const }));

/** Images already in the built-in registry — the picker lists these first. */
const LOCAL_IMAGES: ImageSuggestion[] = ['acme/web', 'acme/api', 'acme/worker'].map((repo) => ({
  name: `${REGISTRY_HOST}/${repo}`,
  source: 'local' as const,
  description: 'Built-in registry',
  official: false,
  stars: 0,
}));

const TAGS_BY_IMAGE: Record<string, TagSuggestion[]> = {
  nginx: [
    { name: 'latest', updatedAt: iso(3 * DAY) },
    { name: '1.27', updatedAt: iso(4 * DAY) },
    { name: '1.27-alpine', updatedAt: iso(4 * DAY) },
    { name: '1.26', updatedAt: iso(20 * DAY) },
    { name: 'stable', updatedAt: iso(10 * DAY) },
  ],
  redis: [
    { name: 'latest', updatedAt: iso(2 * DAY) },
    { name: '7', updatedAt: iso(2 * DAY) },
    { name: '7-alpine', updatedAt: iso(2 * DAY) },
    { name: '7.4', updatedAt: iso(5 * DAY) },
    { name: '6', updatedAt: iso(30 * DAY) },
  ],
  postgres: [
    { name: 'latest', updatedAt: iso(1 * DAY) },
    { name: '16', updatedAt: iso(1 * DAY) },
    { name: '16-alpine', updatedAt: iso(1 * DAY) },
    { name: '15', updatedAt: iso(12 * DAY) },
    { name: '14', updatedAt: iso(40 * DAY) },
  ],
  node: [
    { name: 'latest', updatedAt: iso(2 * DAY) },
    { name: '22', updatedAt: iso(2 * DAY) },
    { name: '20-alpine', updatedAt: iso(3 * DAY) },
    { name: '20', updatedAt: iso(3 * DAY) },
    { name: '18-alpine', updatedAt: iso(15 * DAY) },
  ],
};

const DEFAULT_TAGS: TagSuggestion[] = [
  { name: 'latest', updatedAt: iso(2 * DAY) },
  { name: 'stable', updatedAt: iso(7 * DAY) },
  { name: '1.0', updatedAt: iso(30 * DAY) },
];

/** Strip namespace + any tag/digest so `library/redis:7` → `redis`. */
function baseImageName(image: string): string {
  const noTag = image.split('@')[0]?.split(':')[0] ?? image;
  return noTag.replace(/^library\//, '');
}

// ── Resolvers ──────────────────────────────────────────────────────────────────

export const cicd: DomainResolvers = {
  seed: (store) => {
    store.extra['cicd'] = buildSeed();
  },

  handlers: {
    // ── Repos ──
    'cicd.listRepos': (_i, s): GitRepoView[] => state(s).repos,

    'cicd.removeRepo': (i, s): { id: string; removed: true } => {
      const { id } = i as { id: string };
      const st = state(s);
      st.repos = st.repos.filter((r) => r.id !== id);
      st.builds = st.builds.filter((bld) => bld.repoId !== id);
      return { id, removed: true };
    },

    // ── Builds ──
    'cicd.listBuilds': (i, s): BuildView[] => {
      const repoId = (i as { repoId?: string } | undefined)?.repoId;
      const builds = state(s).builds;
      return repoId ? builds.filter((b) => b.repoId === repoId) : builds;
    },

    'cicd.triggerBuild': (i, s): BuildView => {
      const { repoId, ref } = i as { repoId: string; ref?: string };
      const st = state(s);
      const repo = st.repos.find((r) => r.id === repoId);
      const usedRef = ref ?? repo?.branch ?? 'main';
      const logsRef = rid('log');
      const imageName = repo
        ? repo.url.replace(/\.git$/, '').replace(/^https?:\/\/[^/]+\//, '').replace(/\//g, '-').toLowerCase()
        : 'app';
      const view: BuildView = {
        id: rid('build'),
        repoId,
        repoUrl: repo?.url ?? '',
        commit: usedRef,
        status: 'building',
        image: `${REGISTRY_HOST}/${imageName}:${usedRef.replace(/[^\w.-]/g, '-')}`,
        logsRef,
        startedAt: new Date().toISOString(),
        finishedAt: null,
        builder: null,
        detected: null,
        cachedSteps: null,
      };
      st.logs[logsRef] = makeBuildLog(view.image ?? '', true);
      st.builds.unshift(view);
      return view;
    },

    // ── Build logs (scrollback page) ──
    'cicd.buildLogPage': (i, s): { lines: BuildLogLine[]; done: boolean; status: string } => {
      const { buildId } = i as { buildId: string };
      const st = state(s);
      const bld = st.builds.find((b) => b.id === buildId);
      const status = bld?.status ?? 'building';
      const running = status === 'building' || status === 'queued' || status === 'pushing';
      const log = bld?.logsRef ? st.logs[bld.logsRef] : undefined;
      // While a build is "running" show partial scrollback so the live tail has
      // something to append; finished builds show the full canned log.
      const lines = log ? (running ? log.lines.slice(0, 6) : log.lines) : [];
      return { lines, done: !running, status };
    },

    // ── Registry ──
    'cicd.getRegistryConfig': (_i, s): RegistryConfigView => state(s).registry,

    'cicd.getRegistryCache': (_i, s): RegistryCacheView => ({
      username: state(s).cacheUsername ?? null,
      applied: true,
      deployed: state(s).registry.enabled,
    }),

    'cicd.setRegistryCacheCredentials': (i, s): RegistryCacheView => {
      const { login } = i as { login: { username: string; password: string } | null };
      const st = state(s);
      st.cacheUsername = login ? login.username.trim() : null;
      return { username: st.cacheUsername, applied: true, deployed: st.registry.enabled };
    },

    'cicd.setRegistryEnabled': (i, s): RegistryConfigView => {
      const b = i as { enabled: boolean; username?: string; password?: string };
      const st = state(s);
      st.registry = {
        ...st.registry,
        enabled: b.enabled,
        host: REGISTRY_HOST,
        hasCreds: true,
        username: b.username && b.password ? b.username : (st.registry.username ?? 'swarmy'),
        login: b.username && b.password ? 'custom' : (st.registry.login ?? 'auto-generated'),
        authEnforced: b.enabled,
        online: b.enabled,
        updatedAt: new Date().toISOString(),
      };
      return st.registry;
    },

    'cicd.rotateRegistryCredentials': (_i, s): RegistryConfigView => {
      const st = state(s);
      st.registry = { ...st.registry, username: 'swarmy', login: 'auto-generated', updatedAt: new Date().toISOString() };
      return st.registry;
    },

    // ── GC policy ──
    'cicd.getGcPolicy': (_i, s): GcPolicyView => state(s).gc,

    'cicd.setGcPolicy': (i, s): GcPolicyView => {
      const b = i as Partial<GcPolicyView> & Pick<GcPolicyView, 'mode' | 'keepProd' | 'days'>;
      const st = state(s);
      st.gc = {
        mode: b.mode,
        keepProd: b.keepProd,
        days: b.days,
        cacheMaxAgeDays: b.cacheMaxAgeDays ?? st.gc.cacheMaxAgeDays,
        cacheMaxGb: b.cacheMaxGb ?? st.gc.cacheMaxGb,
      };
      return st.gc;
    },

    // ── Images (Docker Hub autocomplete proxy) ──
    'images.search': (i): ImageSuggestion[] => {
      const q = (i as { query: string }).query.trim().toLowerCase();
      if (q.length < 2) return [];
      // Built-in registry first, Docker Hub second (as images.service).
      const local = LOCAL_IMAGES.filter((img) => img.name.toLowerCase().includes(q));
      const matches = HUB_IMAGES.filter((img) => img.name.toLowerCase().includes(q));
      const hub = matches.length > 0 || local.length > 0 ? matches : HUB_IMAGES;
      return [...local, ...hub].slice(0, 13);
    },

    'images.tags': (i): TagSuggestion[] => {
      const image = (i as { image: string }).image;
      if (!image.trim()) return [];
      return TAGS_BY_IMAGE[baseImageName(image)] ?? DEFAULT_TAGS;
    },
  },

  subscriptions: {
    // Live build-log tail: drip the canned log for the build, line by line, then
    // mark the build succeeded so the page flips to a finished state.
    'cicd.buildLogs': (i, s, emit): (() => void) => {
      const { buildId } = i as { buildId: string };
      const st = state(s);
      const bld = st.builds.find((b) => b.id === buildId);
      const log = bld?.logsRef ? st.logs[bld.logsRef] : undefined;
      const all = log?.lines ?? [];
      // Continue past the partial scrollback the page already seeded.
      let idx = 6;

      const timer = setInterval(() => {
        if (idx >= all.length) {
          clearInterval(timer);
          if (bld && (bld.status === 'building' || bld.status === 'queued' || bld.status === 'pushing')) {
            bld.status = 'succeeded';
            bld.finishedAt = new Date().toISOString();
          }
          return;
        }
        const line = all[idx];
        if (line) emit(line);
        idx += 1;
      }, 700);

      return () => clearInterval(timer);
    },
  },
};
