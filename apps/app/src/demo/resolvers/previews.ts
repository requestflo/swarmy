import type { PreviewSettingsView, PreviewView } from '@swarmy/core';
import type { DemoStore, DomainResolvers } from '../types';

/**
 * Preview-environments demo resolvers — the Previews section on the CI page:
 * per-repo settings, live PR stacks, manual branch previews and destroy.
 *
 * State lives in `store.extra.previews`. Return shapes mirror the controller
 * exactly: `PreviewView`/`PreviewSettingsView` from @swarmy/core plus the
 * `PrEventResult`/`TeardownResult` shapes of previews.service.ts.
 */

const HOUR = 60 * 60 * 1000;

/** Mirror of previews.service `PrEventResult`. */
interface PrEventResult {
  action: 'deployed' | 'torn-down' | 'skipped';
  stack?: string;
  url?: string | null;
  reason?: string;
}

/** Mirror of previews.service `TeardownResult`. */
interface TeardownResult {
  stack: string;
  removedServices: number;
  removedSecrets: number;
}

interface PreviewsState {
  /** repoId → saved settings (repos come from the cicd demo seed). */
  settingsByRepo: Record<string, PreviewSettingsView>;
  previews: PreviewView[];
}

/** Short names for the cicd demo repos (`repo-web` … — see resolvers/cicd.ts). */
const REPO_SHORT: Record<string, string> = {
  'repo-web': 'web',
  'repo-api': 'api',
  'repo-checkout': 'checkout',
};

const DEFAULTS: PreviewSettingsView = {
  enabled: false,
  baseDomain: '',
  ttlHours: 72,
  teardownOnClose: true,
};

function iso(agoMs: number): string {
  return new Date(Date.now() - agoMs).toISOString();
}

function preview(over: Partial<PreviewView> & Pick<PreviewView, 'stack' | 'repo' | 'pr' | 'branch'>): PreviewView {
  const createdAt = over.createdAt ?? iso(6 * HOUR);
  const ttlHours = over.ttlHours ?? 72;
  return {
    url: null,
    serviceCount: 2,
    runningServices: 2,
    status: 'running',
    ...over,
    createdAt,
    ttlHours,
    expiresAt: ttlHours > 0 && createdAt ? new Date(Date.parse(createdAt) + ttlHours * HOUR).toISOString() : null,
  };
}

function buildSeed(): PreviewsState {
  return {
    settingsByRepo: {
      'repo-web': { enabled: true, baseDomain: 'preview.northwind.dev', ttlHours: 72, teardownOnClose: true },
      'repo-api': { enabled: true, baseDomain: 'preview.northwind.dev', ttlHours: 48, teardownOnClose: true },
    },
    previews: [
      preview({
        stack: 'pr142-web',
        repo: 'web',
        pr: 142,
        branch: 'feat/checkout-v2',
        url: 'https://pr-142.preview.northwind.dev',
        createdAt: iso(26 * HOUR),
        serviceCount: 3,
        runningServices: 3,
        status: 'running',
      }),
      preview({
        stack: 'pr87-api',
        repo: 'api',
        pr: 87,
        branch: 'fix/rate-limits',
        url: 'https://pr-87.preview.northwind.dev',
        createdAt: iso(2 * HOUR),
        ttlHours: 48,
        serviceCount: 2,
        runningServices: 1,
        status: 'deploying',
      }),
    ],
  };
}

function state(s: DemoStore): PreviewsState {
  return s.extra['previews'] as PreviewsState;
}

/** Mirror of previews.service `branchPreviewNumber` (FNV-1a → 90000–99999). */
function branchPreviewNumber(branch: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < branch.length; i++) {
    h ^= branch.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return 90_000 + ((h >>> 0) % 10_000);
}

export const previews: DomainResolvers = {
  seed: (store) => {
    store.extra['previews'] = buildSeed();
  },

  handlers: {
    'previews.list': (_i, s): PreviewView[] =>
      [...state(s).previews].sort((a, b) => b.pr - a.pr || a.stack.localeCompare(b.stack)),

    'previews.getSettings': (i, s): PreviewSettingsView => {
      const { repoId } = i as { repoId: string };
      return state(s).settingsByRepo[repoId] ?? { ...DEFAULTS };
    },

    'previews.setSettings': (i, s): PreviewSettingsView => {
      const input = i as PreviewSettingsView & { repoId: string };
      const next: PreviewSettingsView = {
        enabled: input.enabled,
        baseDomain: (input.baseDomain ?? '').toLowerCase(),
        ttlHours: input.ttlHours ?? 72,
        teardownOnClose: input.teardownOnClose ?? true,
      };
      state(s).settingsByRepo[input.repoId] = next;
      return next;
    },

    'previews.createManual': (i, s): PrEventResult => {
      const { repoId, branch } = i as { repoId: string; branch: string };
      const st = state(s);
      const settings = st.settingsByRepo[repoId] ?? DEFAULTS;
      if (!settings.enabled) return { action: 'skipped', reason: 'previews are disabled for this repo' };
      const short = REPO_SHORT[repoId] ?? 'app';
      const pr = branchPreviewNumber(branch);
      const stack = `pr${pr}-${short}`;
      const url = settings.baseDomain ? `https://pr-${pr}.${settings.baseDomain}` : null;
      st.previews = st.previews.filter((p) => p.stack !== stack);
      st.previews.push(
        preview({
          stack,
          repo: short,
          pr,
          branch,
          url,
          createdAt: new Date().toISOString(),
          ttlHours: settings.ttlHours,
          serviceCount: 2,
          runningServices: 0,
          status: 'deploying',
        }),
      );
      return { action: 'deployed', stack, url };
    },

    'previews.destroy': (i, s): TeardownResult => {
      const { stack } = i as { stack: string };
      const st = state(s);
      const found = st.previews.find((p) => p.stack === stack);
      st.previews = st.previews.filter((p) => p.stack !== stack);
      return { stack, removedServices: found?.serviceCount ?? 0, removedSecrets: 0 };
    },
  },
};
