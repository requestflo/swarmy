import type {
  ApplyConfigResult,
  AttachConfigResult,
  ConfigConsumerView,
  ConfigContentView,
  ConfigFamilyView,
  ConfigRestartPreviewView,
  ConfigsListView,
  CreateConfigResult,
  DeleteConfigFamilyResult,
  DetachConfigResult,
  NewConfigVersionResult,
  OrphanConfigView,
  PruneConfigVersionsResult,
} from '@swarmy/core';
import type { DemoStore, DomainResolvers } from '../types';

/**
 * Configs-manager demo resolvers — the Configs surface (`/configs`): families,
 * versions with READABLE content, diffs, restart previews, apply/rollback.
 * Return shapes mirror `configsMgr.service.ts` views exactly (imported from
 * @swarmy/core, never redeclared). State lives in `store.extra.configsmgr`;
 * mutations rewrite it so the page reflects changes after invalidation.
 */

interface FamState {
  family: string;
  mountPath: string;
  /** newest first */
  versions: { version: number; createdAt: string; content: string }[];
  /** serviceId → pinned version */
  consumers: { serviceId: string; version: number }[];
}

interface ConfigsState {
  families: FamState[];
  orphans: OrphanConfigView[];
}

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const iso = (agoMs: number): string => new Date(Date.now() - agoMs).toISOString();
const physical = (family: string, version: number): string => `${family}__v${version}`;

function getState(store: DemoStore): ConfigsState {
  return store.extra.configsmgr as ConfigsState;
}

function require_(st: ConfigsState, family: string): FamState {
  const f = st.families.find((x) => x.family === family);
  if (!f) throw new Error(`config family "${family}" not found`);
  return f;
}

/** Stack NAME a demo service belongs to ('(ungrouped)' when stackless). */
function stackOfService(store: DemoStore, serviceName: string): string {
  const svc = store.services.find((s) => s.name === serviceName);
  return store.stacks.find((st) => st.id === svc?.stackId)?.name ?? '(ungrouped)';
}

function consumerViews(f: FamState, store: DemoStore): ConfigConsumerView[] {
  const current = f.versions[0]!.version;
  const stackName = (stackId: string | null): string =>
    store.stacks.find((s) => s.id === stackId)?.name ?? '(ungrouped)';
  return f.consumers
    .map((c) => {
      const svc = store.services.find((s) => s.id === c.serviceId);
      return {
        serviceId: c.serviceId,
        serviceName: svc?.name ?? c.serviceId,
        stack: stackName(svc?.stackId ?? null),
        version: c.version,
        upToDate: c.version === current,
      };
    })
    .sort((a, b) => a.serviceName.localeCompare(b.serviceName));
}

function toView(f: FamState, store: DemoStore): ConfigFamilyView {
  const current = f.versions[0]!;
  const consumers = consumerViews(f, store);
  return {
    family: f.family,
    currentVersion: current.version,
    mountPath: f.mountPath,
    versions: f.versions.map((v) => ({
      version: v.version,
      name: physical(f.family, v.version),
      createdAt: v.createdAt,
      current: v.version === current.version,
      consumers: consumers.filter((c) => c.version === v.version).map((c) => c.serviceName),
    })),
    lastUpdatedAt: current.createdAt,
    createdAt: f.versions[f.versions.length - 1]!.createdAt,
    consumers,
    usedByCount: consumers.length,
    staleConsumers: consumers.filter((c) => !c.upToDate).length,
  };
}

export const configsmgr: DomainResolvers = {
  handlers: {
    'configs.list': (i, s): ConfigsListView => {
      const { stack } = (i as { stack?: string } | null | undefined) ?? {};
      const st = getState(s);
      const families = st.families
        .map((f) => toView(f, s))
        .sort((a, b) => a.family.localeCompare(b.family));
      if (!stack) return { families, orphans: st.orphans };
      // Stack scope mirrors the controller: attached-in-stack OR unattached
      // (a just-created config must stay visible everywhere).
      return {
        families: families.filter(
          (f) => f.usedByCount === 0 || f.consumers.some((c) => c.stack === stack),
        ),
        orphans: st.orphans.filter(
          (o) =>
            o.consumers.length === 0 || o.consumers.some((n) => stackOfService(s, n) === stack),
        ),
      };
    },

    'configs.content': (i, s): ConfigContentView => {
      const { family, version } = i as { family: string; version?: number };
      const f = require_(getState(s), family);
      const current = f.versions[0]!;
      const target =
        version === undefined ? current : f.versions.find((v) => v.version === version);
      if (!target) throw new Error(`config version "${family} v${version}" not found`);
      return {
        family,
        version: target.version,
        name: physical(family, target.version),
        content: target.content,
        mountPath: f.mountPath,
        createdAt: target.createdAt,
        current: target.version === current.version,
      };
    },

    'configs.restartPreview': (i, s): ConfigRestartPreviewView => {
      const { family, version } = i as { family: string; version?: number };
      const f = require_(getState(s), family);
      const targetVersion = version ?? f.versions[0]!.version;
      if (!f.versions.some((v) => v.version === targetVersion)) {
        throw new Error(`config version "${family} v${targetVersion}" not found`);
      }
      const consumers = consumerViews(f, s);
      return {
        family,
        targetVersion,
        restarting: consumers.filter((c) => c.version !== targetVersion),
        upToDate: consumers.filter((c) => c.version === targetVersion),
      };
    },

    'configs.create': (i, s): CreateConfigResult => {
      const b = i as { family: string; content: string; mountPath?: string; stack?: string };
      const st = getState(s);
      if (st.families.some((f) => f.family === b.family)) {
        throw new Error(`config family "${b.family}" already exists — edit it instead`);
      }
      const mountPath = b.mountPath?.trim() || `/${b.family}`;
      st.families.push({
        family: b.family,
        mountPath,
        versions: [{ version: 1, createdAt: new Date().toISOString(), content: b.content }],
        consumers: [],
      });
      return { family: b.family, version: 1, name: physical(b.family, 1), mountPath };
    },

    'configs.newVersion': (i, s): NewConfigVersionResult => {
      const b = i as { family: string; content: string };
      const f = require_(getState(s), b.family);
      const previousVersion = f.versions[0]!.version;
      const version = previousVersion + 1;
      f.versions.unshift({ version, createdAt: new Date().toISOString(), content: b.content });
      return { family: b.family, version, name: physical(b.family, version), previousVersion };
    },

    'configs.applyVersion': (i, s): ApplyConfigResult => {
      const b = i as { family: string; version: number };
      const f = require_(getState(s), b.family);
      if (!f.versions.some((v) => v.version === b.version)) {
        throw new Error(`config version "${b.family} v${b.version}" not found`);
      }
      const rollback = b.version < f.versions[0]!.version;
      const redeployed: string[] = [];
      const skipped: string[] = [];
      for (const c of f.consumers) {
        const name = s.services.find((svc) => svc.id === c.serviceId)?.name ?? c.serviceId;
        if (c.version === b.version) skipped.push(name);
        else {
          c.version = b.version;
          redeployed.push(name);
        }
      }
      return {
        family: b.family,
        version: b.version,
        redeployed: redeployed.sort(),
        skipped: skipped.sort(),
        rollback,
      };
    },

    'configs.attach': (i, s): AttachConfigResult => {
      const b = i as { family: string; service: string };
      const f = require_(getState(s), b.family);
      const svc = s.services.find((x) => x.id === b.service || x.name === b.service);
      if (!svc) throw new Error(`service "${b.service}" not found`);
      const version = f.versions[0]!.version;
      const existing = f.consumers.find((c) => c.serviceId === svc.id);
      if (existing) existing.version = version;
      else f.consumers.push({ serviceId: svc.id, version });
      return { family: b.family, service: svc.name, version, mountPath: f.mountPath };
    },

    'configs.detach': (i, s): DetachConfigResult => {
      const b = i as { family: string; service: string };
      const f = require_(getState(s), b.family);
      const svc = s.services.find((x) => x.id === b.service || x.name === b.service);
      const before = f.consumers.length;
      f.consumers = f.consumers.filter((c) => c.serviceId !== (svc?.id ?? b.service));
      if (f.consumers.length === before) {
        throw new Error(`service "${b.service}" does not use config "${b.family}"`);
      }
      return { family: b.family, service: svc?.name ?? b.service, detached: true };
    },

    'configs.deleteFamily': (i, s): DeleteConfigFamilyResult => {
      const { family } = i as { family: string };
      const st = getState(s);
      const f = require_(st, family);
      if (f.consumers.length > 0) {
        throw new Error(
          `config "${family}" is used by ${f.consumers.length} service(s) — detach them first`,
        );
      }
      st.families = st.families.filter((x) => x.family !== family);
      return { family, removedVersions: f.versions.map((v) => v.version).sort((a, b) => a - b) };
    },

    'configs.pruneVersions': (i, s): PruneConfigVersionsResult => {
      const { family } = i as { family: string };
      const f = require_(getState(s), family);
      const current = f.versions[0]!.version;
      const inUse = new Set(f.consumers.map((c) => c.version));
      const removed = f.versions
        .filter((v) => v.version !== current && !inUse.has(v.version))
        .map((v) => v.version);
      const kept = f.versions
        .filter((v) => v.version !== current && inUse.has(v.version))
        .map((v) => v.version);
      f.versions = f.versions.filter((v) => v.version === current || inUse.has(v.version));
      return {
        family,
        removedVersions: removed.sort((a, b) => a - b),
        keptInUse: kept.sort((a, b) => a - b),
        currentVersion: current,
      };
    },
  },

  seed: (store) => {
    // Two families with 3 versions each (per the manifest): a Caddy snippet
    // where web is CURRENT but cdn-edge lags on v2 (drives the warning hero,
    // stale badges and a meaningful restart preview), and an app config the
    // api + worker read at the current version. Version contents differ so
    // the editor's diff preview shows real, plausible line changes.
    const caddyV1 = [
      '# shared caddy snippet',
      'encode gzip',
      'header {',
      '\tX-Frame-Options DENY',
      '}',
    ].join('\n');
    const caddyV2 = [
      '# shared caddy snippet',
      'encode gzip zstd',
      'header {',
      '\tX-Frame-Options DENY',
      '\tX-Content-Type-Options nosniff',
      '}',
    ].join('\n');
    const caddyV3 = [
      '# shared caddy snippet',
      'encode gzip zstd',
      'header {',
      '\tX-Frame-Options DENY',
      '\tX-Content-Type-Options nosniff',
      '\tStrict-Transport-Security "max-age=31536000; includeSubDomains"',
      '}',
      'log {',
      '\toutput stdout',
      '\tformat json',
      '}',
    ].join('\n');

    const appV1 = [
      'server:',
      '  port: 8080',
      'features:',
      '  checkout_v2: false',
      'limits:',
      '  request_timeout_ms: 5000',
    ].join('\n');
    const appV2 = [
      'server:',
      '  port: 8080',
      'features:',
      '  checkout_v2: false',
      '  search_suggestions: true',
      'limits:',
      '  request_timeout_ms: 5000',
    ].join('\n');
    const appV3 = [
      'server:',
      '  port: 8080',
      'features:',
      '  checkout_v2: true',
      '  search_suggestions: true',
      'limits:',
      '  request_timeout_ms: 8000',
      '  max_body_kb: 512',
    ].join('\n');

    const state: ConfigsState = {
      families: [
        {
          family: 'caddy-snippet',
          mountPath: '/etc/caddy/snippets/common.caddy',
          versions: [
            { version: 3, createdAt: iso(3 * DAY), content: caddyV3 },
            { version: 2, createdAt: iso(30 * DAY), content: caddyV2 },
            { version: 1, createdAt: iso(75 * DAY), content: caddyV1 },
          ],
          consumers: [
            { serviceId: 'svc-web', version: 3 },
            { serviceId: 'svc-cdn', version: 2 }, // stale — still on v2
          ],
        },
        {
          family: 'app-config',
          mountPath: '/etc/app/config.yaml',
          versions: [
            { version: 3, createdAt: iso(6 * HOUR), content: appV3 },
            { version: 2, createdAt: iso(12 * DAY), content: appV2 },
            { version: 1, createdAt: iso(60 * DAY), content: appV1 },
          ],
          consumers: [
            { serviceId: 'svc-api', version: 3 },
            { serviceId: 'svc-worker', version: 3 },
          ],
        },
      ],
      orphans: [
        {
          id: 'corph-1',
          name: 'prometheus-scrape-config',
          createdAt: iso(200 * DAY),
          consumers: ['prometheus'],
        },
        { id: 'corph-2', name: 'legacy-nginx-conf', createdAt: iso(320 * DAY), consumers: [] },
      ],
    };
    store.extra.configsmgr = state;
  },
};
