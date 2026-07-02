import type { OrgContext } from '../context';
import type { AdmissionIntent, Violation } from './admission.service';
import {
  DEFAULT_REGISTRY_HOST,
  isOrgRegistryImage,
  refAtDigest,
  verifyImageSignature,
} from './registryPolicy.service';

/**
 * Image-policy admission evaluator (slice D3) — enforces the org registry
 * policy against every image an intent would deploy *from the org registry*
 * (third-party images from public registries are out of scope):
 *
 * - `blockCriticalCves`: latest `ImageScan` (by digest when the ref is pinned,
 *   else by ref) — criticals block, a missing/errored scan warns `unscanned`.
 * - `requireSignedImages`: cosign verify, memoized per digest for
 *   {@link VERIFY_CACHE_TTL_MS} — a synchronous verify per deploy is heavy, so
 *   the cache absorbs repeat deploys; a cache miss verifies inline once (60s
 *   timeout inside `verifyImageSignature`) and FAILS CLOSED on any failure.
 */

export const VERIFY_CACHE_TTL_MS = 10 * 60_000;

interface CacheEntry {
  ok: boolean;
  at: number;
}

/** digest (or ref when unpinned) → last definitive cosign verify result. */
const verifyCache = new Map<string, CacheEntry>();

/** Pure cache read honoring the TTL (exported for tests). */
export function readVerifyCache(
  cache: Map<string, CacheEntry>,
  key: string,
  now: number,
  ttlMs: number = VERIFY_CACHE_TTL_MS,
): boolean | undefined {
  const hit = cache.get(key);
  if (!hit) return undefined;
  if (now - hit.at > ttlMs) {
    cache.delete(key);
    return undefined;
  }
  return hit.ok;
}

/** Test hook: drop all memoized verify results. */
export function clearVerifyCache(): void {
  verifyCache.clear();
}

// ── Pure decision core (unit-tested) ─────────────────────────────────────────

export interface ImagePolicyFlags {
  requireSignedImages: boolean;
  blockCriticalCves: boolean;
}

export interface CandidateImage {
  /** Service name (for the violation's `resource`), best-effort. */
  service: string;
  /** Full image ref as it appears in the spec. */
  image: string;
  /** `sha256:…` when the ref is digest-pinned. */
  digest: string | null;
}

export interface ScanFact {
  status: 'passed' | 'failed' | 'error';
  criticalCount: number;
}

/** Digest from a pinned ref (`…@sha256:x` → `sha256:x`), else null. */
export function digestOf(image: string): string | null {
  const at = image.lastIndexOf('@');
  return at >= 0 ? image.slice(at + 1) : null;
}

/** Pull the org-registry images (with service names) out of intent specs. */
export function extractOrgImages(specs: unknown[], registryHost: string): CandidateImage[] {
  const out: CandidateImage[] = [];
  const seen = new Set<string>();
  for (const raw of specs) {
    const spec = raw as { name?: unknown; image?: unknown };
    if (typeof spec?.image !== 'string' || !spec.image) continue;
    if (!isOrgRegistryImage(spec.image, registryHost)) continue;
    if (seen.has(spec.image)) continue;
    seen.add(spec.image);
    out.push({
      service: typeof spec.name === 'string' ? spec.name : spec.image,
      image: spec.image,
      digest: digestOf(spec.image),
    });
  }
  return out;
}

/**
 * Pure admission decision given already-gathered facts. `scanFor` returns the
 * latest scan fact (or null → unscanned); `signatureFor` returns the verify
 * outcome (true verified, false definitively unverified, null = could not
 * verify → fail closed).
 */
export function decideImageAdmission(input: {
  policy: ImagePolicyFlags;
  images: CandidateImage[];
  scanFor: (image: CandidateImage) => ScanFact | null;
  signatureFor: (image: CandidateImage) => boolean | null;
}): Violation[] {
  const violations: Violation[] = [];
  for (const image of input.images) {
    if (input.policy.blockCriticalCves) {
      const scan = input.scanFor(image);
      if (!scan || scan.status === 'error') {
        violations.push({
          rule: 'images/unscanned',
          severity: 'warn',
          message: `${image.image} has no CVE scan yet — build it through CI or rescan from the registry panel.`,
          resource: image.service,
        });
      } else if (scan.criticalCount > 0) {
        violations.push({
          rule: 'images/critical-cves',
          severity: 'block',
          message: `${image.image} has ${scan.criticalCount} critical CVE${scan.criticalCount === 1 ? '' : 's'} — fix or override to deploy.`,
          resource: image.service,
        });
      }
    }
    if (input.policy.requireSignedImages) {
      const signed = input.signatureFor(image);
      if (signed !== true) {
        violations.push({
          rule: 'images/unsigned',
          severity: 'block',
          message:
            signed === false
              ? `${image.image} is not signed with the org cosign key — rebuild with signing enabled or override.`
              : `${image.image}: signature could not be verified (verify failed or timed out) — failing closed.`,
          resource: image.service,
        });
      }
    }
  }
  return violations;
}

// ── Evaluator (spine contract) ───────────────────────────────────────────────

export async function evaluate(ctx: OrgContext, intent: AdmissionIntent): Promise<Violation[]> {
  if (intent.kind !== 'stack.deploy' && intent.kind !== 'service.deploy') return [];
  const cfg = await ctx.db.registryConfig.findUnique({ where: { orgId: ctx.activeOrgId } });
  if (!cfg || (!cfg.requireSignedImages && !cfg.blockCriticalCves)) return [];

  const host = cfg.host ?? DEFAULT_REGISTRY_HOST;
  const images = extractOrgImages(intent.specs ?? [], host);
  if (images.length === 0) return [];

  // Latest scan per image: digest match wins (a rescan of the same bits counts),
  // else the newest scan of the same ref.
  const scans = new Map<string, ScanFact | null>();
  for (const img of images) {
    const row = await ctx.db.imageScan.findFirst({
      where: {
        orgId: ctx.activeOrgId,
        ...(img.digest ? { digest: img.digest } : { imageRef: img.image }),
      },
      orderBy: { scannedAt: 'desc' },
      select: { status: true, criticalCount: true },
    });
    scans.set(
      img.image,
      row
        ? { status: row.status.toLowerCase() as ScanFact['status'], criticalCount: row.criticalCount }
        : null,
    );
  }

  // Signature verification (only when required): cache per digest, verify
  // inline once on a miss. Definitive results are cached; dispatch failures
  // (node offline / timeout) are NOT cached and fail closed this evaluation.
  const signatures = new Map<string, boolean | null>();
  if (cfg.requireSignedImages) {
    const now = Date.now();
    for (const img of images) {
      const key = img.digest ?? img.image;
      const cached = readVerifyCache(verifyCache, key, now);
      if (cached !== undefined) {
        signatures.set(img.image, cached);
        continue;
      }
      if (!cfg.cosignPublicKey) {
        // Signing was never enabled — nothing can verify; definitive false.
        signatures.set(img.image, false);
        continue;
      }
      try {
        const ref = img.digest ? refAtDigest(img.image, img.digest) : img.image;
        const ok = await verifyImageSignature(ctx, ref);
        verifyCache.set(key, { ok, at: now });
        signatures.set(img.image, ok);
      } catch {
        signatures.set(img.image, null);
      }
    }
  }

  return decideImageAdmission({
    policy: {
      requireSignedImages: cfg.requireSignedImages,
      blockCriticalCves: cfg.blockCriticalCves,
    },
    images,
    scanFor: (img) => scans.get(img.image) ?? null,
    signatureFor: (img) => signatures.get(img.image) ?? null,
  });
}
