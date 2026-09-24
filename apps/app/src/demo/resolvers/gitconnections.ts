import type { DemoStore, DomainResolvers } from '../types';

/**
 * Git-provider connection demo resolvers (router `gitConnections`) — the
 * Connections card and the "New app from Git" wizard on /ci.
 *
 * State lives in `store.extra.gitConnections`. Shapes mirror
 * packages/trpc/src/services/git-connections.service.ts (GitConnectionView,
 * GithubAppView, LinkedRepoView, inspect result) and git-providers/types.ts
 * (ProviderRepo). Provider round-trips (GitHub manifest / install, GitLab
 * OAuth) hand back a same-origin `/ci?git=connected…` path, which the UI
 * navigates to inside the SPA so the in-memory world survives.
 */

type Kind = 'github' | 'gitlab' | 'gitea' | 'generic';

interface ConnectionView {
  id: string;
  kind: Kind;
  displayName: string;
  baseUrl: string;
  account: string | null;
  status: string;
  repoCount: number;
  createdAt: string;
}

interface ProviderRepo {
  id: string;
  fullName: string;
  cloneUrl: string;
  htmlUrl: string;
  defaultBranch: string;
  private: boolean;
}

interface GitState {
  /** webBases with a registered GitHub App (github.com + a GHES that isn't installed anywhere yet). */
  githubApps: string[];
  connections: ConnectionView[];
  /** connectionId → the repos that provider can see. */
  repos: Record<string, ProviderRepo[]>;
  /** linked repo id → what `inspect` needs to fake a believable tree. */
  linked: Record<string, { fullName: string; configPath: string; branch: string }>;
}

const GITHUB_WEB = 'https://github.com';
const webBaseOf = (i: unknown): string =>
  ((i as { webBase?: string } | undefined)?.webBase ?? GITHUB_WEB).replace(/\/+$/, '');
const DAY = 24 * 60 * 60 * 1000;
const iso = (agoMs: number): string => new Date(Date.now() - agoMs).toISOString();
const rid = (p: string): string => `${p}-${Math.random().toString(36).slice(2, 10)}`;
const sha = (): string =>
  Array.from({ length: 40 }, () => Math.floor(Math.random() * 16).toString(16)).join('');

/** Stable per-name numeric id (FNV-1a), like a provider repo id. */
function repoId(name: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < name.length; i++) h = Math.imul(h ^ name.charCodeAt(i), 0x01000193);
  return String(h >>> 0);
}

function gh(fullName: string, defaultBranch = 'main', priv = true): ProviderRepo {
  return {
    id: repoId(fullName),
    fullName,
    cloneUrl: `https://github.com/${fullName}.git`,
    htmlUrl: `https://github.com/${fullName}`,
    defaultBranch,
    private: priv,
  };
}

function buildSeed(): GitState {
  return {
    githubApps: [GITHUB_WEB, 'https://github.corp.example'],
    connections: [
      {
        id: 'gc-github',
        kind: 'github',
        displayName: 'northwind',
        baseUrl: 'https://github.com',
        account: 'northwind',
        status: 'active',
        repoCount: 2,
        createdAt: iso(40 * DAY),
      },
      {
        id: 'gc-gitlab',
        kind: 'gitlab',
        displayName: 'GitLab',
        baseUrl: 'https://gitlab.com',
        account: 'dana.ops',
        status: 'active',
        repoCount: 1,
        createdAt: iso(12 * DAY),
      },
    ],
    repos: {
      'gc-github': [
        gh('northwind/web'),
        gh('northwind/api'),
        gh('northwind/platform'),
        gh('northwind/docs', 'main', false),
        gh('northwind/legacy-billing', 'master'),
      ],
      'gc-gitlab': [
        {
          id: '48213907',
          fullName: 'northwind/infra/checkout',
          cloneUrl: 'https://gitlab.com/northwind/infra/checkout.git',
          htmlUrl: 'https://gitlab.com/northwind/infra/checkout',
          defaultBranch: 'main',
          private: true,
        },
      ],
    },
    linked: {},
  };
}

function state(s: DemoStore): GitState {
  const existing = s.extra['gitConnections'] as GitState | undefined;
  if (existing) return existing;
  const fresh = buildSeed();
  s.extra['gitConnections'] = fresh;
  return fresh;
}

const connectedPath = (kind: Kind, id: string): string =>
  `/ci?git=connected&kind=${kind}&connection=${id}`;

function addConnection(
  st: GitState,
  c: Omit<ConnectionView, 'id' | 'repoCount' | 'createdAt' | 'status'>,
): ConnectionView {
  const conn: ConnectionView = {
    ...c,
    id: rid('gc'),
    status: 'active',
    repoCount: 0,
    createdAt: new Date().toISOString(),
  };
  st.connections.push(conn);
  st.repos[conn.id] =
    c.kind === 'gitea'
      ? [
          {
            ...gh('team/app'),
            cloneUrl: `${c.baseUrl}/team/app.git`,
            htmlUrl: `${c.baseUrl}/team/app`,
          },
        ]
      : [];
  return conn;
}

/** Push the new binding into the CI demo slice so the Repositories list shows it. */
function mirrorIntoCicd(
  s: DemoStore,
  row: { id: string; url: string; branch: string; kind: Kind | null },
): void {
  const cicd = s.extra['cicd'] as { repos?: unknown[] } | undefined;
  if (!cicd?.repos) return;
  // A fresh array: the demo link hands back store references, and query
  // structural sharing would otherwise see the mutated list as unchanged.
  cicd.repos = [
    {
      id: row.id,
      provider: row.kind === 'gitlab' ? 'gitlab' : 'github',
      url: row.url,
      branch: row.branch,
      autodeploy: true,
      serviceId: null,
      hasToken: row.kind !== null,
      createdAt: new Date().toISOString(),
    },
    ...cicd.repos,
  ];
}

/** A believable repo tree by name: `…/platform` is a monorepo, `…/legacy-billing` predates swarmy. */
function fakeInspect(name: string, configPath: string) {
  const tree = name.endsWith('/platform')
    ? [
        'services/orders/swarmy.yaml',
        'services/orders/Dockerfile',
        'services/payments/swarmy.yaml',
        'services/payments/Dockerfile',
        'package.json',
      ]
    : name.endsWith('/legacy-billing')
      ? ['Dockerfile', 'docker-compose.yml', 'Gemfile']
      : ['swarmy.yaml', 'package.json', 'pnpm-lock.yaml'];
  const configPaths = tree.filter((p) => /(^|\/)swarmy\.ya?ml$/.test(p));
  const files: Record<string, string | null> = {
    [configPath]: configPaths.includes(configPath) ? 'version: 1\n' : null,
  };
  // Mirrors git-providers/detect-build.ts for the demo repos.
  const detected = tree.includes('Dockerfile') || tree.some((p) => p.endsWith('/Dockerfile'))
    ? { builder: 'dockerfile' as const, summary: 'Dockerfile found — swarmy builds it as-is' }
    : {
        builder: 'railpack' as const,
        provider: 'node',
        language: 'Node.js',
        framework: 'Next.js',
        runtime: 'Node 22',
        packageManager: 'pnpm',
        start: 'pnpm start',
        port: 3000,
        healthPath: '/',
        summary: 'Next.js · Node 22 · start: pnpm start',
      };
  // A compose-only repo gets the converted starter the real controller returns.
  const composeDraft =
    configPaths.length === 0 && tree.includes('docker-compose.yml')
      ? {
          from: 'docker-compose.yml',
          yaml: [
            '# Converted from docker-compose by swarmy — review before you commit it.',
            'version: 1',
            'app: legacy-billing',
            'services:',
            '  web:',
            '    build: .',
            '    port: 3000',
            '    env:',
            '      DATABASE_URL: ${{ db.url }}',
            'resources:',
            '  db: postgres',
            '',
          ].join('\n'),
          notes: [
            'db (postgres:15) becomes a managed postgres resource "db" — swarmy runs, backs up and wires it.',
            'web: DATABASE_URL now binds to ${{ db.url }} (swarmy fills in the real address and password).',
          ],
        }
      : null;
  return { sha: sha(), files, tree, configPaths, detected, composeDraft };
}

export const gitconnections: DomainResolvers = {
  seed: (store) => {
    store.extra['gitConnections'] = buildSeed();
  },

  handlers: {
    // Copies — see mirrorIntoCicd on why store references can't be returned.
    'gitConnections.list': (_i, s): ConnectionView[] => state(s).connections.map((c) => ({ ...c })),

    'gitConnections.githubApp': (i, s) => {
      const webBase = webBaseOf(i);
      const registered = state(s).githubApps.includes(webBase);
      const slug = webBase === GITHUB_WEB ? 'swarmy-northwind' : 'swarmy-corp';
      return {
        registered,
        slug: registered ? slug : null,
        name: registered ? `swarmy (${webBase === GITHUB_WEB ? 'northwind' : 'corp'})` : null,
        htmlUrl: registered ? `${webBase}/apps/${slug}` : null,
        webBase,
      };
    },

    'gitConnections.startGithubManifest': (i, s) => {
      const st = state(s);
      const org = (i as { githubOrg?: string } | undefined)?.githubOrg;
      const webBase = webBaseOf(i);
      if (st.githubApps.includes(webBase))
        throw new Error('This controller already has a GitHub App — install it instead.');
      st.githubApps.push(webBase);
      // Real flow: manifest → install on GitHub → back here. The demo does both at once.
      const conn = addConnection(st, {
        kind: 'github',
        displayName: org ?? 'demo-user',
        baseUrl: webBase,
        account: org ?? 'demo-user',
      });
      st.repos[conn.id] = [gh(`${conn.account}/hello-swarmy`)];
      return { postUrl: connectedPath('github', conn.id), manifest: '{}' };
    },

    'gitConnections.githubInstallLink': (i, s) => {
      const st = state(s);
      const webBase = webBaseOf(i);
      if (!st.githubApps.includes(webBase)) throw new Error('Register the GitHub App first.');
      let conn = st.connections.find((c) => c.kind === 'github' && c.baseUrl === webBase);
      if (!conn) {
        // Installing somewhere new — the demo binds a fresh installation.
        conn = addConnection(st, {
          kind: 'github',
          displayName: 'platform-team',
          baseUrl: webBase,
          account: 'platform-team',
        });
        st.repos[conn.id] = [gh('platform-team/billing')];
      }
      return { url: connectedPath('github', conn.id) };
    },

    'gitConnections.create': (i, s) => {
      const b = i as {
        kind: Kind;
        mode: string;
        baseUrl?: string;
        displayName?: string;
        tokenUser?: string;
      };
      const st = state(s);
      const baseUrl = (b.baseUrl ?? (b.kind === 'gitlab' ? 'https://gitlab.com' : '')).replace(
        /\/+$/,
        '',
      );
      const host = baseUrl.replace(/^https?:\/\//, '');
      const conn = addConnection(st, {
        kind: b.kind,
        displayName:
          b.displayName ?? (b.kind === 'gitlab' ? (host === 'gitlab.com' ? 'GitLab' : host) : host),
        baseUrl,
        account: b.kind === 'gitlab' ? 'demo-user' : (b.tokenUser ?? null),
      });
      if (b.kind === 'gitlab')
        st.repos[conn.id] = [
          {
            ...gh('demo-user/shop'),
            id: '51000001',
            cloneUrl: `${baseUrl}/demo-user/shop.git`,
            htmlUrl: `${baseUrl}/demo-user/shop`,
          },
        ];
      return b.mode === 'oauth'
        ? { connection: conn, authorizeUrl: connectedPath('gitlab', conn.id) }
        : { connection: conn };
    },

    'gitConnections.remove': (i, s) => {
      const { id } = i as { id: string };
      const st = state(s);
      st.connections = st.connections.filter((c) => c.id !== id);
      return { id, removed: true };
    },

    'gitConnections.repos': (i, s): ProviderRepo[] => {
      const { connectionId, search } = i as { connectionId: string; search?: string };
      const all = state(s).repos[connectionId] ?? [];
      const q = search?.toLowerCase();
      return q ? all.filter((r) => r.fullName.toLowerCase().includes(q)) : all;
    },

    'gitConnections.branches': (i, s) => {
      const { connectionId, repo } = i as { connectionId: string; repo: string };
      const r = (state(s).repos[connectionId] ?? []).find(
        (x) => x.fullName === repo || x.id === repo,
      );
      const names = [r?.defaultBranch ?? 'main', 'staging', 'feat/checkout-v2', 'fix/rate-limits'];
      return names.map((name) => ({ name, sha: sha() }));
    },

    'gitConnections.linkRepo': (i, s) => {
      const b = i as {
        connectionId?: string;
        repo?: { id: string; fullName: string; cloneUrl: string };
        url?: string;
        branch: string;
        configPath?: string;
        deployKey?: boolean;
      };
      const st = state(s);
      const conn = st.connections.find((c) => c.id === b.connectionId) ?? null;
      const url = b.repo?.cloneUrl ?? b.url ?? '';
      const configPath = (b.configPath ?? 'swarmy.yaml').replace(/^\.?\/+/, '');
      const id = rid('repo');
      if (conn) conn.repoCount += 1;
      const fullName = b.repo?.fullName ?? url.replace(/^.*[:/]([^/]+\/[^/]+?)(\.git)?$/, '$1');
      st.linked[id] = { fullName, configPath, branch: b.branch };
      mirrorIntoCicd(s, { id, url, branch: b.branch, kind: conn?.kind ?? null });
      const ssh = /^(ssh:\/\/|[\w.-]+@[\w.-]+:)/.test(url);
      const needsHook = conn?.kind !== 'github' && conn?.kind !== 'gitlab';
      return {
        id,
        url,
        branch: b.branch,
        configPath,
        fullName: b.repo?.fullName ?? null,
        webhook: needsHook
          ? {
              url: `https://swarmy.northwind.dev/webhooks/git/${id}`,
              secret: `whsec_${Math.random().toString(36).slice(2, 26)}`,
            }
          : null,
        deployKeyPublic:
          b.deployKey || (!conn && ssh)
            ? `ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAI${Math.random().toString(36).slice(2, 30)} swarmy@demo`
            : null,
      };
    },

    'gitConnections.inspect': (i, s) => {
      const { repoId } = i as { repoId: string };
      const row = state(s).linked[repoId];
      return fakeInspect(row?.fullName ?? '', row?.configPath ?? 'swarmy.yaml');
    },

    'gitConnections.inspectSource': (i) => {
      const { cloneUrl, paths } = i as { cloneUrl: string; paths?: string[] };
      const name = cloneUrl.replace(/\.git$/, '');
      return fakeInspect(name, paths?.[0] ?? 'swarmy.yaml');
    },

    'gitConnections.updateRepo': (i, s) => {
      const b = i as { id: string; branch?: string; configPath?: string };
      const row = state(s).linked[b.id];
      if (row) {
        if (b.branch) row.branch = b.branch;
        if (b.configPath) row.configPath = b.configPath.replace(/^\.?\/+/, '');
      }
      return {
        id: b.id,
        branch: row?.branch ?? b.branch ?? 'main',
        configPath: row?.configPath ?? 'swarmy.yaml',
      };
    },
  },
};
