import type { OrgContext } from '../context';
import type { SignVerdict } from './image-signature';

/**
 * Record one definitive cosign answer about a digest (`ImageSignatureCheck`,
 * queryable history beside `ImageScan`). Best-effort: history never fails the
 * deploy admission is gating or the build that just signed.
 */
export async function recordSignatureCheck(
  ctx: OrgContext,
  row: { digest: string; imageRef: string; verdict: SignVerdict; keyName: string | null; source: 'admission' | 'build' },
): Promise<void> {
  try {
    await ctx.db.imageSignatureCheck.create({ data: { orgId: ctx.activeOrgId, ...row } });
  } catch {
    /* history is best-effort */
  }
}
