import type { DemoStore, DomainResolvers } from '../types';

/**
 * Registry-credentials demo resolvers — third-party pull logins (GHCR, Docker
 * Hub, …) on the CI page. Mirrors `RegistryCredentialView` /
 * `RegistryTestResult` (registry-credentials.service.ts). The secret is
 * write-only, so it is accepted and dropped — never stored or returned.
 */

type Provider = 'ghcr' | 'dockerhub' | 'gitlab' | 'ecr' | 'gcr' | 'acr' | 'generic';

interface CredView {
  id: string;
  prefix: string;
  provider: Provider;
  label: string | null;
  username: string;
  hasSecret: true;
  lastTestedAt: string | null;
  lastTestOk: boolean | null;
  lastTestMessage: string | null;
  createdAt: string;
  updatedAt: string;
}

const KEY = 'registrycreds';
const rows = (s: DemoStore): CredView[] => s.extra[KEY] as CredView[];
const now = (): string => new Date().toISOString();

function normalize(prefix: string): string {
  const p = prefix.trim().replace(/^[a-z]+:\/\//i, '').replace(/\/+$/, '').toLowerCase();
  return ['index.docker.io', 'registry-1.docker.io'].includes(p) ? 'docker.io' : p;
}

function guess(prefix: string): Provider {
  const host = prefix.split('/')[0] ?? '';
  if (host === 'ghcr.io') return 'ghcr';
  if (host === 'docker.io') return 'dockerhub';
  if (host.includes('gitlab')) return 'gitlab';
  if (host.endsWith('.amazonaws.com')) return 'ecr';
  if (host.endsWith('-docker.pkg.dev') || host.endsWith('gcr.io')) return 'gcr';
  if (host.endsWith('.azurecr.io')) return 'acr';
  return 'generic';
}

export const registrycreds: DomainResolvers = {
  handlers: {
    'registryCredentials.list': (_i, s) => rows(s),
    'registryCredentials.upsert': (i, s) => {
      const b = i as { prefix: string; username: string; provider?: Provider; label?: string | null };
      const prefix = normalize(b.prefix);
      const list = rows(s);
      const existing = list.find((r) => r.prefix === prefix);
      const base = { username: b.username, label: b.label ?? null, lastTestedAt: null, lastTestOk: null, lastTestMessage: null, updatedAt: now() };
      if (existing) return Object.assign(existing, base, { provider: b.provider ?? existing.provider });
      const row: CredView = {
        id: `rc-${Math.random().toString(36).slice(2, 10)}`,
        prefix,
        provider: b.provider ?? guess(prefix),
        hasSecret: true,
        createdAt: now(),
        ...base,
      };
      list.push(row);
      list.sort((a, b2) => a.prefix.localeCompare(b2.prefix));
      return row;
    },
    'registryCredentials.update': (i, s) => {
      const b = i as { id: string; username?: string; label?: string | null; secret?: string };
      const row = rows(s).find((r) => r.id === b.id);
      if (!row) throw new Error(`registryCredential "${b.id}" not found`);
      if (b.username !== undefined) row.username = b.username;
      if (b.label !== undefined) row.label = b.label;
      if (b.secret !== undefined) Object.assign(row, { lastTestedAt: null, lastTestOk: null, lastTestMessage: null });
      row.updatedAt = now();
      return row;
    },
    'registryCredentials.remove': (i, s) => {
      const { id } = i as { id: string };
      s.extra[KEY] = rows(s).filter((r) => r.id !== id);
      return { ok: true };
    },
    'registryCredentials.test': (i, s) => {
      const b = i as { id?: string; image?: string };
      const image = b.image?.trim();
      const result = image?.includes('missing')
        ? { ok: false, status: 'not_found', message: `${image} not found`, checkedManifest: true }
        : { ok: true, status: 'ok', message: image ? `can pull ${image}` : 'login accepted', checkedManifest: !!image };
      const row = b.id ? rows(s).find((r) => r.id === b.id) : undefined;
      if (row) Object.assign(row, { lastTestedAt: now(), lastTestOk: result.ok, lastTestMessage: result.message });
      return result;
    },
  },
  seed: (store) => {
    const day = 86_400_000;
    const at = (ago: number) => new Date(Date.now() - ago).toISOString();
    store.extra[KEY] = [
      {
        id: 'rc-dockerhub',
        prefix: 'docker.io',
        provider: 'dockerhub',
        label: 'Hub pull-rate login',
        username: 'northwind',
        hasSecret: true,
        lastTestedAt: at(2 * day),
        lastTestOk: true,
        lastTestMessage: 'login accepted',
        createdAt: at(30 * day),
        updatedAt: at(30 * day),
      },
      {
        id: 'rc-ghcr',
        prefix: 'ghcr.io/northwind',
        provider: 'ghcr',
        label: null,
        username: 'northwind-bot',
        hasSecret: true,
        lastTestedAt: at(day / 4),
        lastTestOk: true,
        lastTestMessage: 'can pull northwind/billing:1.8',
        createdAt: at(12 * day),
        updatedAt: at(12 * day),
      },
    ] satisfies CredView[];
  },
};
