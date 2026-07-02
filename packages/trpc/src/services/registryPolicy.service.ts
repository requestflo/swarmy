/**
 * Registry policy — image CVE scanning (trivy), image signing (cosign), and the
 * admission toggles enforced by `admission-images.ts` (slice D3).
 *
 * Docker-native split: scan history is queryable history → the `ImageScan`
 * Prisma model; the policy toggles + org cosign keypair live on the existing
 * one-per-org `RegistryConfig` row (the private key vault-encrypted, never
 * returned to clients). All swarm work — trivy scans, cosign keygen/sign/verify
 * — runs through `container.runOnce` dispatched to an agent; the controller
 * never touches a registry or overlay network itself.
 */
import { decryptSecret, encryptSecret, randomToken } from '@swarmy/core/crypto';
import type {
  ImageScanCveView,
  ImageScanDetailView,
  ImageScanStatusKind,
  ImageScanView,
  RegistryPolicyView,
  SigningStatusView,
} from '@swarmy/core/views';
import type { RunOnceResult } from '@swarmy/core/protocol';
import type { OrgContext } from '../context';
import { mapDispatchError, notFound } from '../errors';
import { resolveManagerNode } from './dispatch.service';
import { writeAudit } from './audit.service';

// ── Constants ────────────────────────────────────────────────────────────────

export const TRIVY_IMAGE = 'aquasec/trivy:0.58.1';
export const COSIGN_IMAGE = 'gcr.io/projectsigstore/cosign:v2.4.1';
const KEYGEN_SHELL_IMAGE = 'busybox:1.36';
const KEYGEN_VOLUME = 'swarmy-cosign-keygen';
const KEYGEN_SPLIT_MARKER = '@@SWARMY-COSIGN-SPLIT@@';
export const DEFAULT_REGISTRY_HOST = 'swarmy-registry:5000';
/** Trivy's own scan timeout (`--timeout 8m`) + container/dispatch headroom. */
const SCAN_TIMEOUT_MS = 9 * 60_000;
const SIGN_TIMEOUT_MS = 2 * 60_000;
export const VERIFY_TIMEOUT_MS = 60_000;
/** Keep at most this many CVEs in `ImageScan.reportJson` (sorted worst-first). */
export const MAX_REPORT_CVES = 50;

// ── Pure helpers (unit-tested) ───────────────────────────────────────────────

const SEVERITY_RANK: Record<string, number> = {
  CRITICAL: 0,
  HIGH: 1,
  MEDIUM: 2,
  LOW: 3,
  UNKNOWN: 4,
};

export interface ParsedTrivyReport {
  criticalCount: number;
  highCount: number;
  mediumCount: number;
  lowCount: number;
  totalCves: number;
  /** Worst-first, trimmed to {@link MAX_REPORT_CVES}. */
  cves: ImageScanCveView[];
  /** `sha256:…` from `Metadata.RepoDigests[0]` when trivy reported one. */
  digest: string | null;
}

/**
 * Extract the JSON document from combined runOnce output: trivy logs progress
 * lines to stderr (interleaved into the combined tail), so we slice from the
 * first `{` to the last `}` before parsing.
 */
export function extractJsonBlock(output: string): string {
  const start = output.indexOf('{');
  const end = output.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('no JSON document in scanner output');
  return output.slice(start, end + 1);
}

/**
 * Parse a trivy `--format json` report (possibly wrapped in log noise) into
 * severity counts + a trimmed worst-first CVE list. Throws on malformed input —
 * the caller records an ERROR scan.
 */
export function parseTrivyReport(output: string): ParsedTrivyReport {
  const doc = JSON.parse(extractJsonBlock(output)) as {
    Results?: Array<{
      Vulnerabilities?: Array<{
        VulnerabilityID?: string;
        Severity?: string;
        PkgName?: string;
        InstalledVersion?: string;
        FixedVersion?: string;
        Title?: string;
      }> | null;
    }> | null;
    Metadata?: { RepoDigests?: string[] | null } | null;
  };
  if (typeof doc !== 'object' || doc === null || !('Results' in doc || 'Metadata' in doc)) {
    throw new Error('not a trivy report');
  }

  const counts = { criticalCount: 0, highCount: 0, mediumCount: 0, lowCount: 0 };
  const cves: ImageScanCveView[] = [];
  for (const result of doc.Results ?? []) {
    for (const v of result.Vulnerabilities ?? []) {
      const severity = (v.Severity ?? 'UNKNOWN').toUpperCase();
      if (severity === 'CRITICAL') counts.criticalCount++;
      else if (severity === 'HIGH') counts.highCount++;
      else if (severity === 'MEDIUM') counts.mediumCount++;
      else if (severity === 'LOW') counts.lowCount++;
      cves.push({
        id: v.VulnerabilityID ?? 'UNKNOWN',
        severity,
        pkgName: v.PkgName ?? '',
        installedVersion: v.InstalledVersion ?? '',
        fixedVersion: v.FixedVersion ?? null,
        title: v.Title ?? null,
      });
    }
  }
  cves.sort(
    (a, b) => (SEVERITY_RANK[a.severity] ?? 9) - (SEVERITY_RANK[b.severity] ?? 9) || a.id.localeCompare(b.id),
  );

  const repoDigest = doc.Metadata?.RepoDigests?.[0];
  const at = repoDigest?.lastIndexOf('@') ?? -1;
  return {
    ...counts,
    totalCves: cves.length,
    cves: cves.slice(0, MAX_REPORT_CVES),
    digest: repoDigest && at >= 0 ? repoDigest.slice(at + 1) : null,
  };
}

/** `host:5000/name:tag` → `host:5000/name` (never clips a registry port). */
export function stripTag(imageRef: string): string {
  const slash = imageRef.lastIndexOf('/');
  const colon = imageRef.indexOf(':', slash + 1);
  return colon >= 0 ? imageRef.slice(0, colon) : imageRef;
}

/** Digest-pinned ref for cosign: `host/name:tag` + `sha256:…` → `host/name@sha256:…`. */
export function refAtDigest(imageRef: string, digest: string): string {
  const at = imageRef.indexOf('@');
  if (at >= 0) return `${imageRef.slice(0, at)}@${digest}`;
  return `${stripTag(imageRef)}@${digest}`;
}

/** True when the image was pushed to the org's in-swarm registry. */
export function isOrgRegistryImage(image: string, registryHost: string): boolean {
  return image.startsWith(`${registryHost}/`);
}

/** Split the keygen shell output into the two PEMs (unit-tested). */
export function splitKeygenOutput(
  output: string,
  marker: string = KEYGEN_SPLIT_MARKER,
): { privateKey: string; publicKey: string } {
  const idx = output.indexOf(marker);
  if (idx < 0) throw new Error('cosign keygen output missing split marker');
  const privateKey = output.slice(0, idx).trim();
  const publicKey = output.slice(idx + marker.length).trim();
  if (!privateKey.includes('PRIVATE KEY') || !publicKey.includes('PUBLIC KEY')) {
    throw new Error('cosign keygen output did not contain a keypair');
  }
  return { privateKey, publicKey };
}

// ── Config plumbing ──────────────────────────────────────────────────────────

interface PolicyRow {
  enabled: boolean;
  host: string | null;
  credentialsEnc: string | null;
  requireSignedImages: boolean;
  blockCriticalCves: boolean;
  cosignPublicKey: string | null;
  cosignPrivateKeyEnc: string | null;
  updatedAt: Date;
}

async function ensurePolicyConfig(ctx: OrgContext): Promise<PolicyRow> {
  return ctx.db.registryConfig.upsert({
    where: { orgId: ctx.activeOrgId },
    create: { orgId: ctx.activeOrgId, enabled: false, host: DEFAULT_REGISTRY_HOST },
    update: {},
  });
}

function registryCreds(row: PolicyRow): { username: string; password: string } | null {
  if (!row.credentialsEnc) return null;
  try {
    return JSON.parse(decryptSecret(row.credentialsEnc)) as { username: string; password: string };
  } catch {
    return null;
  }
}

/** Pick an online builder node (label `swarmy.role=builder`), else any online node. */
async function resolveScanNode(ctx: OrgContext): Promise<{ id: string }> {
  const nodes = await ctx.db.node.findMany({
    where: { orgId: ctx.activeOrgId },
    select: { id: true },
  });
  const builders = nodes.filter(
    (n) => ctx.hub.nodeInfoFor(n.id)?.labels['swarmy.role'] === 'builder',
  );
  const onlineBuilder = builders.find((n) => ctx.hub.isOnline(n.id));
  if (onlineBuilder) return { id: onlineBuilder.id };
  const anyOnline = nodes.find((n) => ctx.hub.isOnline(n.id));
  if (anyOnline) return { id: anyOnline.id };
  return resolveManagerNode(ctx);
}

// ── Policy (toggles) ─────────────────────────────────────────────────────────

function toPolicyView(row: PolicyRow): RegistryPolicyView {
  return {
    requireSignedImages: row.requireSignedImages,
    blockCriticalCves: row.blockCriticalCves,
    signingEnabled: Boolean(row.cosignPublicKey),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export async function getPolicy(ctx: OrgContext): Promise<RegistryPolicyView> {
  return toPolicyView(await ensurePolicyConfig(ctx));
}

export async function setPolicy(
  ctx: OrgContext,
  input: { requireSignedImages?: boolean; blockCriticalCves?: boolean },
): Promise<RegistryPolicyView> {
  await ensurePolicyConfig(ctx);
  const row = await ctx.db.registryConfig.update({
    where: { orgId: ctx.activeOrgId },
    data: {
      ...(input.requireSignedImages !== undefined
        ? { requireSignedImages: input.requireSignedImages }
        : {}),
      ...(input.blockCriticalCves !== undefined ? { blockCriticalCves: input.blockCriticalCves } : {}),
    },
  });
  await writeAudit(ctx, {
    action: 'registryPolicy.set',
    targetType: 'registryConfig',
    targetId: ctx.activeOrgId,
    metadata: { ...input },
  });
  return toPolicyView(row);
}

// ── Scans ────────────────────────────────────────────────────────────────────

interface ScanRow {
  id: string;
  imageRef: string;
  digest: string | null;
  scanner: string;
  criticalCount: number;
  highCount: number;
  mediumCount: number;
  lowCount: number;
  status: string;
  scannedAt: Date;
  reportJson?: unknown;
}

function toScanView(row: ScanRow): ImageScanView {
  return {
    id: row.id,
    imageRef: row.imageRef,
    digest: row.digest,
    scanner: row.scanner,
    criticalCount: row.criticalCount,
    highCount: row.highCount,
    mediumCount: row.mediumCount,
    lowCount: row.lowCount,
    status: row.status.toLowerCase() as ImageScanStatusKind,
    scannedAt: row.scannedAt.toISOString(),
  };
}

export async function listScans(
  ctx: OrgContext,
  input?: { imageRef?: string; limit?: number },
): Promise<ImageScanView[]> {
  const rows = await ctx.db.imageScan.findMany({
    where: { orgId: ctx.activeOrgId, ...(input?.imageRef ? { imageRef: input.imageRef } : {}) },
    orderBy: { scannedAt: 'desc' },
    take: input?.limit ?? 50,
  });
  return rows.map(toScanView);
}

export async function scanDetail(ctx: OrgContext, id: string): Promise<ImageScanDetailView> {
  const row = await ctx.db.imageScan.findFirst({ where: { id, orgId: ctx.activeOrgId } });
  if (!row) throw notFound('scan', id);
  const report = (row.reportJson ?? {}) as {
    cves?: ImageScanCveView[];
    totalCves?: number;
    error?: string;
  };
  return {
    ...toScanView(row),
    cves: report.cves ?? [],
    totalCves: report.totalCves ?? report.cves?.length ?? 0,
    error: report.error ?? null,
  };
}

/**
 * Run a trivy scan of `imageRef` on a node (via `container.runOnce`, attached
 * to the `swarmy` overlay so the in-swarm registry resolves) and persist the
 * `ImageScan`. Status is `passed` unless the exec/parse failed (`error`) —
 * criticals showing up is a *policy* matter, decided at admission time.
 */
async function runScan(
  ctx: OrgContext,
  nodeId: string,
  imageRef: string,
  knownDigest: string | null,
): Promise<ImageScanView> {
  const cfg = await ensurePolicyConfig(ctx);
  const creds = registryCreds(cfg);
  try {
    const res = await ctx.hub.dispatch<RunOnceResult>(
      nodeId,
      'container.runOnce',
      {
        image: TRIVY_IMAGE,
        cmd: [
          'image',
          '--format',
          'json',
          '--scanners',
          'vuln',
          '--timeout',
          '8m',
          '--quiet',
          // The in-swarm registry:2 speaks plain HTTP on the overlay.
          '--insecure',
          imageRef,
        ],
        // Reuse the registry auth builds push with (trivy reads TRIVY_USERNAME/PASSWORD).
        env: creds ? { TRIVY_USERNAME: creds.username, TRIVY_PASSWORD: creds.password } : undefined,
        networks: ['swarmy'],
        timeoutMs: SCAN_TIMEOUT_MS,
      },
      { timeoutMs: SCAN_TIMEOUT_MS + 30_000 },
    );
    if (res.exitCode !== 0) {
      throw new Error(`trivy exited ${res.exitCode}: ${res.output.slice(-1500)}`);
    }
    const parsed = parseTrivyReport(res.output);
    const row = await ctx.db.imageScan.create({
      data: {
        orgId: ctx.activeOrgId,
        imageRef,
        digest: knownDigest ?? parsed.digest,
        scanner: 'trivy',
        criticalCount: parsed.criticalCount,
        highCount: parsed.highCount,
        mediumCount: parsed.mediumCount,
        lowCount: parsed.lowCount,
        reportJson: { cves: parsed.cves, totalCves: parsed.totalCves } as object,
        status: 'PASSED',
      },
    });
    return toScanView(row);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    const row = await ctx.db.imageScan.create({
      data: {
        orgId: ctx.activeOrgId,
        imageRef,
        digest: knownDigest,
        scanner: 'trivy',
        reportJson: { cves: [], totalCves: 0, error: message.slice(0, 2000) } as object,
        status: 'ERROR',
      },
    });
    return toScanView(row);
  }
}

/** Manual rescan from the dashboard (audited; runs on a builder node). */
export async function rescan(ctx: OrgContext, imageRef: string): Promise<ImageScanView> {
  const node = await resolveScanNode(ctx).catch((e) => {
    throw mapDispatchError(e);
  });
  await writeAudit(ctx, {
    action: 'registryPolicy.rescan',
    targetType: 'imageScan',
    targetId: imageRef,
    metadata: { imageRef },
  });
  return runScan(ctx, node.id, imageRef, null);
}

// ── Signing ──────────────────────────────────────────────────────────────────

export async function signingStatus(ctx: OrgContext): Promise<SigningStatusView> {
  const row = await ensurePolicyConfig(ctx);
  return { enabled: Boolean(row.cosignPublicKey), publicKey: row.cosignPublicKey };
}

/**
 * Generate the org cosign keypair ONCE (idempotent): `cosign generate-key-pair`
 * in a one-shot container writing into a scratch volume, then a busybox one-shot
 * reads both PEMs back and deletes them. The private key + its COSIGN_PASSWORD
 * are vault-encrypted into `RegistryConfig.cosignPrivateKeyEnc`; the public key
 * is stored plain (it is not a secret).
 */
export async function enableSigning(ctx: OrgContext): Promise<SigningStatusView> {
  const existing = await ensurePolicyConfig(ctx);
  if (existing.cosignPublicKey) {
    return { enabled: true, publicKey: existing.cosignPublicKey };
  }
  const node = await resolveScanNode(ctx);
  const password = randomToken('cosignpw');
  const volume = `${KEYGEN_VOLUME}-${ctx.activeOrgId.slice(0, 12)}`;

  try {
    const gen = await ctx.hub.dispatch<RunOnceResult>(
      node.id,
      'container.runOnce',
      {
        image: COSIGN_IMAGE,
        cmd: ['generate-key-pair', '--output-key-prefix', '/keys/cosign'],
        env: { COSIGN_PASSWORD: password },
        binds: [`${volume}:/keys`],
        timeoutMs: SIGN_TIMEOUT_MS,
      },
      { timeoutMs: SIGN_TIMEOUT_MS + 30_000 },
    );
    if (gen.exitCode !== 0) throw new Error(`cosign generate-key-pair exited ${gen.exitCode}: ${gen.output.slice(-1000)}`);

    // Read the PEMs back and delete them — the volume must not keep key material.
    const read = await ctx.hub.dispatch<RunOnceResult>(
      node.id,
      'container.runOnce',
      {
        image: KEYGEN_SHELL_IMAGE,
        cmd: [
          'sh',
          '-c',
          `cat /keys/cosign.key && echo "${KEYGEN_SPLIT_MARKER}" && cat /keys/cosign.pub && rm -f /keys/cosign.key /keys/cosign.pub`,
        ],
        binds: [`${volume}:/keys`],
        timeoutMs: 60_000,
      },
      { timeoutMs: 90_000 },
    );
    if (read.exitCode !== 0) throw new Error(`cosign key readback exited ${read.exitCode}`);
    const { privateKey, publicKey } = splitKeygenOutput(read.output);

    await ctx.db.registryConfig.update({
      where: { orgId: ctx.activeOrgId },
      data: {
        cosignPublicKey: publicKey,
        cosignPrivateKeyEnc: encryptSecret(JSON.stringify({ privateKey, password })),
      },
    });
    await writeAudit(ctx, {
      action: 'registryPolicy.enableSigning',
      targetType: 'registryConfig',
      targetId: ctx.activeOrgId,
    });
    return { enabled: true, publicKey };
  } catch (e) {
    throw mapDispatchError(e);
  }
}

/** Sign `imageRef@digest` with the org key (key material only ever in env vars). */
async function signImage(
  ctx: OrgContext,
  nodeId: string,
  cfg: PolicyRow,
  imageRef: string,
  digest: string,
): Promise<void> {
  if (!cfg.cosignPrivateKeyEnc) return;
  const { privateKey, password } = JSON.parse(decryptSecret(cfg.cosignPrivateKeyEnc)) as {
    privateKey: string;
    password: string;
  };
  const creds = registryCreds(cfg);
  const ref = refAtDigest(imageRef, digest);
  const res = await ctx.hub.dispatch<RunOnceResult>(
    nodeId,
    'container.runOnce',
    {
      image: COSIGN_IMAGE,
      cmd: [
        'sign',
        '--key',
        'env://COSIGN_PRIVATE_KEY',
        '--yes',
        // Self-hosted: no Rekor transparency log, plain-HTTP in-swarm registry.
        '--tlog-upload=false',
        '--allow-insecure-registry',
        ...(creds ? ['--registry-username', creds.username, '--registry-password', creds.password] : []),
        ref,
      ],
      env: { COSIGN_PRIVATE_KEY: privateKey, COSIGN_PASSWORD: password },
      networks: ['swarmy'],
      timeoutMs: SIGN_TIMEOUT_MS,
    },
    { timeoutMs: SIGN_TIMEOUT_MS + 30_000 },
  );
  if (res.exitCode !== 0) {
    throw new Error(`cosign sign exited ${res.exitCode}: ${res.output.slice(-1000)}`);
  }
  await writeAudit(ctx, {
    action: 'registryPolicy.sign',
    targetType: 'image',
    targetId: ref,
    actorType: 'system',
  });
}

/**
 * Verify a cosign signature for `ref` against the org public key via a one-shot
 * container. Returns true only on a clean exit-0 verify; a nonzero exit means
 * "definitively unsigned/invalid" (false). Dispatch failures propagate so the
 * caller can decide (admission fails closed without caching).
 */
export async function verifyImageSignature(
  ctx: OrgContext,
  ref: string,
): Promise<boolean> {
  const cfg = await ensurePolicyConfig(ctx);
  if (!cfg.cosignPublicKey) return false;
  const creds = registryCreds(cfg);
  const node = await resolveScanNode(ctx);
  const res = await ctx.hub.dispatch<RunOnceResult>(
    node.id,
    'container.runOnce',
    {
      image: COSIGN_IMAGE,
      cmd: [
        'verify',
        '--key',
        'env://COSIGN_PUBLIC_KEY',
        '--insecure-ignore-tlog',
        '--allow-insecure-registry',
        ...(creds ? ['--registry-username', creds.username, '--registry-password', creds.password] : []),
        ref,
      ],
      env: { COSIGN_PUBLIC_KEY: cfg.cosignPublicKey },
      networks: ['swarmy'],
      timeoutMs: VERIFY_TIMEOUT_MS,
    },
    { timeoutMs: VERIFY_TIMEOUT_MS + 15_000 },
  );
  return res.exitCode === 0;
}

// ── Build hook (called by cicd.service — `// D3 hook`) ───────────────────────

/**
 * Post-build registry policy: scan the freshly pushed image with trivy (always,
 * so `blockCriticalCves` has data) and cosign-sign it when org signing is
 * enabled. Best-effort by contract: this NEVER throws — scan failures land as
 * an ERROR `ImageScan`, sign failures are recorded in the audit trail.
 */
export async function onImageBuilt(
  ctx: OrgContext,
  input: { imageRef: string; digest: string | null; nodeId: string },
): Promise<void> {
  try {
    await runScan(ctx, input.nodeId, input.imageRef, input.digest);
  } catch {
    // runScan already persists an ERROR row on failure; never break the build.
  }
  try {
    const cfg = await ensurePolicyConfig(ctx);
    if (cfg.cosignPublicKey && input.digest) {
      await signImage(ctx, input.nodeId, cfg, input.imageRef, input.digest);
    }
  } catch (e) {
    await writeAudit(ctx, {
      action: 'registryPolicy.signFailed',
      targetType: 'image',
      targetId: input.imageRef,
      actorType: 'system',
      metadata: { error: e instanceof Error ? e.message.slice(0, 500) : String(e) },
    });
  }
}
