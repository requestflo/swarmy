import type { DemoStore, DomainResolvers } from '../types';

/**
 * Registry-policy demo resolvers (slice D3) — image CVE scans, cosign signing
 * status and admission policy toggles on the CI page.
 *
 * Return shapes mirror the controller views exactly (RegistryPolicyView,
 * ImageScanView, ImageScanDetailView, SigningStatusView from
 * registryPolicy.service.ts) so the dashboard renders without surprises.
 * State lives in `store.extra.registrypolicy`; mutations mutate it so the page
 * reflects changes after invalidation.
 */

// ── Controller view mirrors ──────────────────────────────────────────────────

/** Mirror of `RegistryPolicyView` (@swarmy/core views). */
interface RegistryPolicyView {
  requireSignedImages: boolean;
  blockCriticalCves: boolean;
  signingEnabled: boolean;
  updatedAt: string;
}

/** Mirror of `ImageScanCveView`. */
interface ImageScanCveView {
  id: string;
  severity: string;
  pkgName: string;
  installedVersion: string;
  fixedVersion: string | null;
  title: string | null;
}

/** Mirror of `ImageScanView` (+ the detail fields kept on the stored row). */
interface ScanRow {
  id: string;
  imageRef: string;
  digest: string | null;
  scanner: string;
  criticalCount: number;
  highCount: number;
  mediumCount: number;
  lowCount: number;
  status: 'passed' | 'failed' | 'error';
  scannedAt: string;
  cves: ImageScanCveView[];
  totalCves: number;
  error: string | null;
}

interface RegistryPolicyState {
  policy: RegistryPolicyView;
  publicKey: string | null;
  scans: ScanRow[];
}

const REGISTRY_HOST = 'swarmy-registry:5000';
const DEMO_PUBLIC_KEY =
  '-----BEGIN PUBLIC KEY-----\nMFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE2fZkq5o1QeXhCu4XxVc9rDemoKEY\ndemoDEMOdemoDEMOdemoDEMOdemoDEMOdemoDEMOdemoDEMOdemoDEMOdA==\n-----END PUBLIC KEY-----';

function iso(agoMs: number): string {
  return new Date(Date.now() - agoMs).toISOString();
}

function rid(prefix: string): string {
  return `${prefix}-${Math.random().toString(36).slice(2, 10)}`;
}

function state(store: DemoStore): RegistryPolicyState {
  return store.extra.registrypolicy as RegistryPolicyState;
}

function toScanView(row: ScanRow): Omit<ScanRow, 'cves' | 'totalCves' | 'error'> {
  const { cves: _cves, totalCves: _t, error: _e, ...view } = row;
  return view;
}

// ── Resolvers ────────────────────────────────────────────────────────────────

export const registrypolicy: DomainResolvers = {
  handlers: {
    'registryPolicy.getPolicy': (_i, s): RegistryPolicyView => state(s).policy,

    'registryPolicy.setPolicy': (i, s): RegistryPolicyView => {
      const b = (i as { requireSignedImages?: boolean; blockCriticalCves?: boolean } | undefined) ?? {};
      const st = state(s);
      if (b.requireSignedImages !== undefined) st.policy.requireSignedImages = b.requireSignedImages;
      if (b.blockCriticalCves !== undefined) st.policy.blockCriticalCves = b.blockCriticalCves;
      st.policy.updatedAt = new Date().toISOString();
      return st.policy;
    },

    'registryPolicy.listScans': (i, s) => {
      const b = (i as { imageRef?: string; limit?: number } | undefined) ?? {};
      return state(s)
        .scans.filter((r) => !b.imageRef || r.imageRef === b.imageRef)
        .slice(0, b.limit ?? 50)
        .map(toScanView);
    },

    'registryPolicy.scanDetail': (i, s): ScanRow => {
      const { id } = i as { id: string };
      const row = state(s).scans.find((r) => r.id === id);
      if (!row) throw new Error(`scan "${id}" not found`);
      return row;
    },

    'registryPolicy.rescan': (i, s) => {
      const { imageRef } = i as { imageRef: string };
      const st = state(s);
      // A rescan of the same bits finds the same CVEs — clone the latest row.
      const prev = st.scans.find((r) => r.imageRef === imageRef);
      const row: ScanRow = prev
        ? { ...prev, id: rid('scan'), scannedAt: new Date().toISOString() }
        : {
            id: rid('scan'),
            imageRef,
            digest: null,
            scanner: 'trivy',
            criticalCount: 0,
            highCount: 0,
            mediumCount: 0,
            lowCount: 0,
            status: 'passed',
            scannedAt: new Date().toISOString(),
            cves: [],
            totalCves: 0,
            error: null,
          };
      st.scans = [row, ...st.scans];
      return toScanView(row);
    },

    'registryPolicy.signingStatus': (_i, s) => {
      const st = state(s);
      return { enabled: st.policy.signingEnabled, publicKey: st.publicKey };
    },

    'registryPolicy.enableSigning': (_i, s) => {
      const st = state(s);
      st.policy.signingEnabled = true;
      st.publicKey = st.publicKey ?? DEMO_PUBLIC_KEY;
      st.policy.updatedAt = new Date().toISOString();
      return { enabled: true, publicKey: st.publicKey };
    },
  },

  seed: (store) => {
    // Policy on + signing key present; two seeded scans matching the demo CI
    // builds: northwind-api is clean, northwind-web carries 2 criticals so the
    // table, drawer and admission story all light up.
    const MIN = 60_000;
    const HOUR = 60 * MIN;
    const scans: ScanRow[] = [
      {
        id: 'scan-api-240',
        imageRef: `${REGISTRY_HOST}/northwind-api:2.4.0`,
        digest: 'sha256:8f3c1a9be2d4706c5a1e0d9f4b83a52e91c7d64f0ab35e8c2917d40b6a5e21c3',
        scanner: 'trivy',
        criticalCount: 0,
        highCount: 0,
        mediumCount: 3,
        lowCount: 11,
        status: 'passed',
        scannedAt: iso(8 * MIN),
        cves: [
          {
            id: 'CVE-2025-31842',
            severity: 'MEDIUM',
            pkgName: 'libxml2',
            installedVersion: '2.12.6-r0',
            fixedVersion: '2.12.7-r0',
            title: 'libxml2: use-after-free in xmlXIncludeProcess',
          },
          {
            id: 'CVE-2025-29087',
            severity: 'MEDIUM',
            pkgName: 'sqlite-libs',
            installedVersion: '3.45.2-r0',
            fixedVersion: '3.45.3-r0',
            title: 'sqlite: integer overflow in concat_ws()',
          },
          {
            id: 'CVE-2025-26519',
            severity: 'MEDIUM',
            pkgName: 'musl',
            installedVersion: '1.2.4-r2',
            fixedVersion: null,
            title: 'musl: out-of-bounds write in iconv EUC-KR decoder',
          },
        ],
        totalCves: 14,
        error: null,
      },
      {
        id: 'scan-web-182',
        imageRef: `${REGISTRY_HOST}/northwind-web:1.8.2`,
        digest: 'sha256:4b1d22e7a90cf34d8a6f5b02c7e19d3a85f60c41d92b7ae35c08e619f7d43b88',
        scanner: 'trivy',
        criticalCount: 2,
        highCount: 4,
        mediumCount: 9,
        lowCount: 17,
        status: 'passed',
        scannedAt: iso(2 * HOUR),
        cves: [
          {
            id: 'CVE-2025-32907',
            severity: 'CRITICAL',
            pkgName: 'openssl',
            installedVersion: '3.1.4-r5',
            fixedVersion: '3.1.8-r0',
            title: 'openssl: RCE via crafted X.509 certificate chain',
          },
          {
            id: 'CVE-2025-30204',
            severity: 'CRITICAL',
            pkgName: 'zlib',
            installedVersion: '1.2.13-r1',
            fixedVersion: '1.3.1-r0',
            title: 'zlib: heap buffer overflow in inflateGetHeader',
          },
          {
            id: 'CVE-2025-27113',
            severity: 'HIGH',
            pkgName: 'libexpat',
            installedVersion: '2.6.0-r0',
            fixedVersion: '2.6.2-r0',
            title: 'expat: XML entity expansion DoS',
          },
          {
            id: 'CVE-2025-24928',
            severity: 'HIGH',
            pkgName: 'curl',
            installedVersion: '8.5.0-r0',
            fixedVersion: '8.7.1-r0',
            title: 'curl: credential leak on cross-origin redirect',
          },
          {
            id: 'CVE-2025-22869',
            severity: 'HIGH',
            pkgName: 'nghttp2',
            installedVersion: '1.58.0-r0',
            fixedVersion: '1.61.0-r0',
            title: 'nghttp2: HTTP/2 CONTINUATION flood',
          },
          {
            id: 'CVE-2025-21614',
            severity: 'HIGH',
            pkgName: 'busybox',
            installedVersion: '1.36.1-r15',
            fixedVersion: null,
            title: 'busybox: awk use-after-free',
          },
        ],
        totalCves: 32,
        error: null,
      },
    ];

    const st: RegistryPolicyState = {
      policy: {
        requireSignedImages: true,
        blockCriticalCves: true,
        signingEnabled: true,
        updatedAt: iso(3 * 24 * HOUR),
      },
      publicKey: DEMO_PUBLIC_KEY,
      scans,
    };
    store.extra.registrypolicy = st;
  },
};
