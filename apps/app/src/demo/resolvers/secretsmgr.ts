import type {
  AttachSecretResult,
  CreateSecretResult,
  DeleteSecretFamilyResult,
  DetachSecretResult,
  OrphanSecretView,
  PruneSecretVersionsResult,
  RotateSecretResult,
  SecretFamilyView,
  SecretsListView,
} from '@swarmy/core';
import type { DemoStore, DomainResolvers } from '../types';

/**
 * Secrets-manager demo resolvers — the Secrets surface (`/secrets`): families,
 * versions, rotation and usage maps. Return shapes mirror
 * `secretsMgr.service.ts` views exactly (imported from @swarmy/core, never
 * redeclared). State lives in `store.extra.secretsmgr`; mutations rewrite it so
 * the page reflects changes after invalidation.
 */

interface FamState {
  family: string;
  /** newest first */
  versions: { version: number; createdAt: string }[];
  /** serviceId → pinned version */
  consumers: { serviceId: string; version: number }[];
}

interface SecretsState {
  families: FamState[];
  orphans: OrphanSecretView[];
}

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const iso = (agoMs: number): string => new Date(Date.now() - agoMs).toISOString();
const physical = (family: string, version: number): string => `${family}__v${version}`;

function getState(store: DemoStore): SecretsState {
  return store.extra.secretsmgr as SecretsState;
}

function require_(st: SecretsState, family: string): FamState {
  const f = st.families.find((x) => x.family === family);
  if (!f) throw new Error(`secret family "${family}" not found`);
  return f;
}

/** Stack NAME a demo service belongs to ('(ungrouped)' when stackless). */
function stackOfService(store: DemoStore, serviceName: string): string {
  const svc = store.services.find((s) => s.name === serviceName);
  return store.stacks.find((st) => st.id === svc?.stackId)?.name ?? '(ungrouped)';
}

function toView(f: FamState, store: DemoStore): SecretFamilyView {
  const current = f.versions[0]!;
  const stackName = (stackId: string | null): string =>
    store.stacks.find((s) => s.id === stackId)?.name ?? '(ungrouped)';
  const consumers = f.consumers
    .map((c) => {
      const svc = store.services.find((s) => s.id === c.serviceId);
      return {
        serviceId: c.serviceId,
        serviceName: svc?.name ?? c.serviceId,
        stack: stackName(svc?.stackId ?? null),
        version: c.version,
        upToDate: c.version === current.version,
      };
    })
    .sort((a, b) => a.serviceName.localeCompare(b.serviceName));

  return {
    family: f.family,
    currentVersion: current.version,
    versions: f.versions.map((v) => ({
      version: v.version,
      name: physical(f.family, v.version),
      createdAt: v.createdAt,
      current: v.version === current.version,
      consumers: consumers.filter((c) => c.version === v.version).map((c) => c.serviceName),
    })),
    lastRotatedAt: current.createdAt,
    createdAt: f.versions[f.versions.length - 1]!.createdAt,
    consumers,
    usedByCount: consumers.length,
    staleConsumers: consumers.filter((c) => !c.upToDate).length,
  };
}

export const secretsmgr: DomainResolvers = {
  handlers: {
    'secrets.list': (i, s): SecretsListView => {
      const { stack } = (i as { stack?: string } | null | undefined) ?? {};
      const st = getState(s);
      const families = st.families
        .map((f) => toView(f, s))
        .sort((a, b) => a.family.localeCompare(b.family));
      if (!stack) return { families, orphans: st.orphans };
      // Stack scope mirrors the controller: attached-in-stack OR unattached
      // (a just-created secret must stay visible everywhere).
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

    'secrets.create': (i, s): CreateSecretResult => {
      const { family } = i as { family: string; value: string; stack?: string };
      const st = getState(s);
      if (st.families.some((f) => f.family === family)) {
        throw new Error(`secret family "${family}" already exists — rotate it instead`);
      }
      st.families.push({
        family,
        versions: [{ version: 1, createdAt: new Date().toISOString() }],
        consumers: [],
      });
      return { family, version: 1, name: physical(family, 1) };
    },

    'secrets.rotate': (i, s): RotateSecretResult => {
      const { family } = i as { family: string; value: string };
      const st = getState(s);
      const f = require_(st, family);
      const version = f.versions[0]!.version + 1;
      f.versions.unshift({ version, createdAt: new Date().toISOString() });
      const redeployed = f.consumers
        .map((c) => s.services.find((svc) => svc.id === c.serviceId)?.name ?? c.serviceId)
        .sort();
      for (const c of f.consumers) c.version = version;
      return { family, version, name: physical(family, version), redeployed };
    },

    'secrets.attach': (i, s): AttachSecretResult => {
      const b = i as { family: string; service: string; envName?: string };
      const st = getState(s);
      const f = require_(st, b.family);
      const svc = s.services.find((x) => x.id === b.service || x.name === b.service);
      if (!svc) throw new Error(`service "${b.service}" not found`);
      const version = f.versions[0]!.version;
      const existing = f.consumers.find((c) => c.serviceId === svc.id);
      if (existing) existing.version = version;
      else f.consumers.push({ serviceId: svc.id, version });
      return {
        family: b.family,
        service: svc.name,
        version,
        mountPath: `/run/secrets/${b.family}`,
        envName: b.envName ?? null,
      };
    },

    'secrets.detach': (i, s): DetachSecretResult => {
      const b = i as { family: string; service: string };
      const st = getState(s);
      const f = require_(st, b.family);
      const svc = s.services.find((x) => x.id === b.service || x.name === b.service);
      const before = f.consumers.length;
      f.consumers = f.consumers.filter((c) => c.serviceId !== (svc?.id ?? b.service));
      if (f.consumers.length === before) {
        throw new Error(`service "${b.service}" does not use secret "${b.family}"`);
      }
      return { family: b.family, service: svc?.name ?? b.service, detached: true };
    },

    'secrets.deleteFamily': (i, s): DeleteSecretFamilyResult => {
      const { family } = i as { family: string };
      const st = getState(s);
      const f = require_(st, family);
      if (f.consumers.length > 0) {
        throw new Error(
          `secret "${family}" is used by ${f.consumers.length} service(s) — detach them first`,
        );
      }
      st.families = st.families.filter((x) => x.family !== family);
      return { family, removedVersions: f.versions.map((v) => v.version).sort((a, b) => a - b) };
    },

    'secrets.pruneVersions': (i, s): PruneSecretVersionsResult => {
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
    // Four families in different states: a well-rotated DATABASE_URL everyone
    // reads, a Stripe key with one consumer STALE on v1 (drives the warning
    // hero + "stale" badges), a fresh OpenAI key, and an unused SMTP password
    // (deletable). Two hand-made orphans show the read-only unmanaged list.
    const state: SecretsState = {
      families: [
        {
          family: 'DATABASE_URL',
          versions: [
            { version: 3, createdAt: iso(6 * DAY) },
            { version: 2, createdAt: iso(45 * DAY) },
            { version: 1, createdAt: iso(120 * DAY) },
          ],
          consumers: [
            { serviceId: 'svc-api', version: 3 },
            { serviceId: 'svc-worker', version: 3 },
            { serviceId: 'svc-checkout', version: 3 },
          ],
        },
        {
          family: 'STRIPE_SECRET_KEY',
          versions: [
            { version: 2, createdAt: iso(2 * DAY) },
            { version: 1, createdAt: iso(90 * DAY) },
          ],
          consumers: [
            { serviceId: 'svc-checkout', version: 1 }, // stale — still on v1
            { serviceId: 'svc-api', version: 2 },
          ],
        },
        {
          family: 'OPENAI_API_KEY',
          versions: [{ version: 1, createdAt: iso(14 * DAY) }],
          consumers: [{ serviceId: 'svc-api', version: 1 }],
        },
        {
          family: 'SMTP_PASSWORD',
          versions: [
            { version: 2, createdAt: iso(30 * DAY) },
            { version: 1, createdAt: iso(200 * DAY) },
          ],
          consumers: [],
        },
      ],
      orphans: [
        {
          id: 'orph-1',
          name: 'grafana-admin-password',
          createdAt: iso(300 * DAY),
          consumers: ['grafana'],
        },
        { id: 'orph-2', name: 'legacy-jwt-signing-key', createdAt: iso(400 * DAY), consumers: [] },
      ],
    };
    store.extra.secretsmgr = state;
  },
};
