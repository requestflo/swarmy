import { TRPCError } from '@trpc/server';

/**
 * Making a bucket public is a typed confirmation, not an approval queue.
 * Reach is `adminProcedure` (`buckets.setAccess`): only owners and admins can
 * change it at all, so there is no member to ask on behalf of, and the
 * person changing it is already the one an approval would go to. What the
 * step adds is that the admin names the bucket, having read the risk:
 * PUBLIC routes `https://<public S3 domain>/<bucket>` from the internet.
 * Garage still asks for a key or a signed link on every request (reachable
 * is not anonymous), so the risk is that any leaked key or signed link for
 * this bucket now works from anywhere, not only inside your servers.
 *
 * Only moving TO public needs it (leaving public, or public → public, never
 * does). `confirm === undefined` is a caller with no person typing: the
 * swarmy.yaml apply, which a reviewed pull request changed. Pure.
 */

export const PUBLIC_CONFIRM_CODE = 'CONFIRM_REQUIRED';

export function publicConfirmRefusal(input: {
  bucket: string;
  from: string;
  to: string;
  confirm: string | null | undefined;
}): TRPCError | null {
  if (input.to !== 'PUBLIC' || input.from === 'PUBLIC' || input.confirm === undefined) return null;
  if ((input.confirm ?? '').trim() === input.bucket) return null;
  return new TRPCError({
    code: 'PRECONDITION_FAILED',
    message: `${input.bucket} would be reachable from the internet, and any leaked key or signed link for it would work from anywhere — type ${input.bucket} to confirm`,
    cause: { swarmyCode: PUBLIC_CONFIRM_CODE, phrase: input.bucket },
  });
}
