import type { DemoStore, DomainResolvers } from '../types';

/**
 * Object-storage demo resolvers — the buckets surface of Data services
 * (`/data/buckets`): Garage buckets, access keys, quotas, usage and app
 * attachment. Return shapes mirror `buckets.service.ts` views exactly
 * (BucketsOverview, BucketDetailView, BucketKeysView, BucketKeyCreatedView,
 * BucketAttachResult) so the dashboard renders without surprises.
 */

// ───────────────────────────────────────────── controller view mirrors ──

interface BucketPermissionsView {
  read: boolean;
  write: boolean;
  owner: boolean;
}

interface BucketQuotaView {
  maxSizeBytes: number | null;
  maxObjects: number | null;
}

interface BucketKeyGrantView {
  accessKeyId: string;
  name: string;
  permissions: BucketPermissionsView;
}

interface BucketSummaryView {
  id: string;
  name: string;
  usageBytes: number;
  objects: number;
  unfinishedUploads: number;
  website: boolean;
  quotas: BucketQuotaView;
  keyCount: number;
}

interface BucketAttachmentView {
  service: string;
  stack: string;
  accessKeyId: string;
  secretName: string;
}

// ───────────────────────────────────────────── demo world ──

interface DemoBucket extends BucketSummaryView {
  grants: BucketKeyGrantView[];
  attachments: BucketAttachmentView[];
}

interface BucketsState {
  endpoint: string;
  region: string;
  buckets: DemoBucket[];
  keys: Array<{ id: string; name: string }>;
}

function getState(store: DemoStore): BucketsState {
  return store.extra.buckets as BucketsState;
}

function hexId(): string {
  let out = '';
  for (let i = 0; i < 8; i++) out += Math.floor(Math.random() * 0xffff).toString(16).padStart(4, '0');
  return out;
}

function keyId(): string {
  return `GK${Math.random().toString(36).slice(2, 12)}`;
}

function keySecret(): string {
  return Array.from({ length: 4 }, () => Math.random().toString(36).slice(2, 14)).join('');
}

function summary(b: DemoBucket): BucketSummaryView {
  const { grants: _g, attachments: _a, ...rest } = b;
  return { ...rest, keyCount: b.grants.length };
}

function requireBucket(st: BucketsState, bucketId: string): DemoBucket {
  const b = st.buckets.find((x) => x.id === bucketId);
  if (!b) throw new Error(`bucket "${bucketId}" not found`);
  return b;
}

const GB = 1024 * 1024 * 1024;

// ───────────────────────────────────────────── resolvers ──

export const buckets: DomainResolvers = {
  handlers: {
    'buckets.overview': (_i, s) => {
      const st = getState(s);
      return {
        state: 'ready' as const,
        endpoint: st.endpoint,
        region: st.region,
        buckets: [...st.buckets]
          .sort((a, b) => (a.name < b.name ? -1 : 1))
          .map(summary),
      };
    },

    'buckets.get': (i, s) => {
      const { bucketId } = i as { bucketId: string };
      const b = requireBucket(getState(s), bucketId);
      return { ...summary(b), keys: b.grants, attachments: b.attachments };
    },

    'buckets.listKeys': (_i, s) => ({
      state: 'ready' as const,
      keys: [...getState(s).keys].sort((a, b) => (a.name < b.name ? -1 : 1)),
    }),

    'buckets.createBucket': (i, s) => {
      const { name } = i as { name: string };
      const st = getState(s);
      if (st.buckets.some((b) => b.name === name)) throw new Error(`bucket "${name}" already exists`);
      const b: DemoBucket = {
        id: hexId(),
        name,
        usageBytes: 0,
        objects: 0,
        unfinishedUploads: 0,
        website: false,
        quotas: { maxSizeBytes: null, maxObjects: null },
        keyCount: 0,
        grants: [],
        attachments: [],
      };
      st.buckets = [b, ...st.buckets];
      return summary(b);
    },

    'buckets.deleteBucket': (i, s) => {
      const { bucketId } = i as { bucketId: string };
      const st = getState(s);
      const b = requireBucket(st, bucketId);
      if (b.objects > 0) {
        throw new Error(`bucket "${b.name}" still holds ${b.objects} object(s) — empty it before deleting`);
      }
      if (b.attachments.length > 0) {
        throw new Error(`bucket "${b.name}" is attached to ${b.attachments.map((a) => a.service).join(', ')} — detach first`);
      }
      st.buckets = st.buckets.filter((x) => x.id !== bucketId);
      return { id: bucketId, removed: true as const };
    },

    'buckets.createKey': (i, s) => {
      const { name } = i as { name: string };
      const st = getState(s);
      const id = keyId();
      st.keys = [...st.keys, { id, name }];
      return { accessKeyId: id, secretAccessKey: keySecret(), name };
    },

    'buckets.deleteKey': (i, s) => {
      const { accessKeyId } = i as { accessKeyId: string };
      const st = getState(s);
      const used = st.buckets.filter((b) => b.attachments.some((a) => a.accessKeyId === accessKeyId));
      if (used.length > 0) {
        throw new Error(`key ${accessKeyId} is used by an attached app — detach first`);
      }
      st.keys = st.keys.filter((k) => k.id !== accessKeyId);
      for (const b of st.buckets) b.grants = b.grants.filter((g) => g.accessKeyId !== accessKeyId);
      return { accessKeyId, removed: true as const };
    },

    'buckets.grantKeyOnBucket': (i, s) => {
      const input = i as {
        bucketId: string;
        accessKeyId: string;
        permissions: BucketPermissionsView;
        mode: 'allow' | 'deny';
      };
      const st = getState(s);
      const b = requireBucket(st, input.bucketId);
      const key = st.keys.find((k) => k.id === input.accessKeyId);
      const existing = b.grants.find((g) => g.accessKeyId === input.accessKeyId);
      const base: BucketPermissionsView = existing?.permissions ?? {
        read: false,
        write: false,
        owner: false,
      };
      const next: BucketPermissionsView = {
        read: input.permissions.read ? input.mode === 'allow' : base.read,
        write: input.permissions.write ? input.mode === 'allow' : base.write,
        owner: input.permissions.owner ? input.mode === 'allow' : base.owner,
      };
      if (!next.read && !next.write && !next.owner) {
        b.grants = b.grants.filter((g) => g.accessKeyId !== input.accessKeyId);
      } else if (existing) {
        existing.permissions = next;
      } else {
        b.grants = [
          ...b.grants,
          { accessKeyId: input.accessKeyId, name: key?.name ?? '', permissions: next },
        ];
      }
      return { bucketId: input.bucketId, accessKeyId: input.accessKeyId, mode: input.mode };
    },

    'buckets.setQuota': (i, s) => {
      const input = i as { bucketId: string; maxSizeBytes: number | null; maxObjects: number | null };
      const b = requireBucket(getState(s), input.bucketId);
      b.quotas = { maxSizeBytes: input.maxSizeBytes, maxObjects: input.maxObjects };
      return summary(b);
    },

    'buckets.setWebsite': (i, s) => {
      const input = i as { bucketId: string; enabled: boolean };
      const b = requireBucket(getState(s), input.bucketId);
      b.website = input.enabled;
      return summary(b);
    },

    'buckets.attachToService': (i, s) => {
      const input = i as { bucketId: string; appService: string };
      const st = getState(s);
      const b = requireBucket(st, input.bucketId);
      const app = s.services.find((x) => x.id === input.appService || x.name === input.appService);
      if (!app) throw new Error(`service "${input.appService}" not found`);
      const already = st.buckets.find((x) => x.attachments.some((a) => a.service === app.name));
      if (already) {
        throw new Error(`service "${app.name}" is already attached to bucket "${already.name}" — detach first`);
      }
      const accessKeyId = keyId();
      const keyName = `swarmy-attach-${app.name}-${b.name}`;
      const secretName = `swarmy-s3-${app.name}-${b.name}`;
      st.keys = [...st.keys, { id: accessKeyId, name: keyName }];
      b.grants = [
        ...b.grants,
        { accessKeyId, name: keyName, permissions: { read: true, write: true, owner: false } },
      ];
      const stack = s.stacks.find((x) => x.id === app.stackId)?.name ?? 'UNGROUPED';
      b.attachments = [...b.attachments, { service: app.name, stack, accessKeyId, secretName }];
      return {
        appService: app.name,
        bucket: b.name,
        accessKeyId,
        secretName,
        endpoint: st.endpoint,
        region: st.region,
      };
    },

    'buckets.detach': (i, s) => {
      const { appService } = i as { appService: string };
      const st = getState(s);
      const b = st.buckets.find((x) =>
        x.attachments.some((a) => a.service === appService),
      );
      if (!b) throw new Error(`service "${appService}" has no bucket attached`);
      const att = b.attachments.find((a) => a.service === appService)!;
      b.attachments = b.attachments.filter((a) => a.service !== appService);
      b.grants = b.grants.filter((g) => g.accessKeyId !== att.accessKeyId);
      st.keys = st.keys.filter((k) => k.id !== att.accessKeyId);
      return { appService, bucket: b.name, detached: true as const };
    },
  },

  seed: (store) => {
    // Three believable buckets: app uploads (attached to the api service),
    // a quota'd backup sink, and a public static-site bucket — enough to light
    // up every column, the public badge, quotas and the attach flow.
    const uploadsKey = 'GK31c9d4a0demo01';
    const ciKey = 'GK7f22b8e1demo02';
    const state: BucketsState = {
      endpoint: 'http://swarmy-garage:3900',
      region: 'swarmy',
      keys: [
        { id: uploadsKey, name: 'swarmy-attach-api-app-uploads' },
        { id: ciKey, name: 'ci-artifacts' },
        { id: 'GK0a45cc19demo03', name: 'laptop-cli' },
      ],
      buckets: [
        {
          id: '2f2f9bc1a04e4d6c8b1e3f7a9d2c5e08a1b4c7d0e3f6a9b2c5d8e1f4a7b0c3d6',
          name: 'app-uploads',
          usageBytes: 18.4 * GB,
          objects: 12_431,
          unfinishedUploads: 2,
          website: false,
          quotas: { maxSizeBytes: null, maxObjects: null },
          keyCount: 1,
          grants: [
            {
              accessKeyId: uploadsKey,
              name: 'swarmy-attach-api-app-uploads',
              permissions: { read: true, write: true, owner: false },
            },
          ],
          attachments: [
            {
              service: 'api',
              stack: 'storefront',
              accessKeyId: uploadsKey,
              secretName: 'swarmy-s3-api-app-uploads',
            },
          ],
        },
        {
          id: '7d0e3f6a9b2c5d8e1f4a7b0c3d62f2f9bc1a04e4d6c8b1e3f7a9d2c5e08a1b4c',
          name: 'db-backups',
          usageBytes: 42.7 * GB,
          objects: 386,
          unfinishedUploads: 0,
          website: false,
          quotas: { maxSizeBytes: 100 * GB, maxObjects: null },
          keyCount: 1,
          grants: [
            {
              accessKeyId: ciKey,
              name: 'ci-artifacts',
              permissions: { read: true, write: true, owner: true },
            },
          ],
          attachments: [],
        },
        {
          id: 'b2c5d8e1f4a7b0c3d62f2f9bc1a04e4d6c8b1e3f7a9d2c5e08a1b4c7d0e3f6a9',
          name: 'static-site',
          usageBytes: 0.92 * GB,
          objects: 1_054,
          unfinishedUploads: 0,
          website: true,
          quotas: { maxSizeBytes: 5 * GB, maxObjects: 50_000 },
          keyCount: 0,
          grants: [],
          attachments: [],
        },
      ],
    };
    for (const b of state.buckets) {
      b.usageBytes = Math.round(b.usageBytes);
      b.keyCount = b.grants.length;
    }
    store.extra.buckets = state;
  },
};
