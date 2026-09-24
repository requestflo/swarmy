/**
 * Error tracking (Sentry-compatible, epic-developer-platform §6). Reads are
 * `orgProcedure`; issue triage (resolve / ignore / reopen) is too — any
 * member can triage, and every change is audited. Opt-in, DSN rotation,
 * rate limits and artifact uploads are `adminProcedure`.
 *
 * Ingest itself is NOT here: SDKs post to `/api/<project>/envelope/` on the
 * controller (apps/api/src/errors-ingest.ts).
 */
import { z } from 'zod';
import { adminProcedure, orgProcedure, router } from '../trpc';
import {
  issueDetail,
  issuesForTrace,
  listIssues,
  listReleases,
  setIssueStatus,
  setStackEnabled,
  stackStatus,
  uploadArtifacts,
} from '../services/errors/errors.service';
import { rotateKey, setRateLimit } from '../services/errors/projects';
import { ISSUE_STATUSES } from '../services/errors/query';

const stack = z.string().min(1).max(100);
const fingerprint = z.string().regex(/^[0-9a-f]{32}$/);

export const errorsRouter = router({
  /** Opt-in state, the DSN, and whether the store is on. */
  status: orgProcedure.input(z.object({ stack })).query(({ ctx, input }) => stackStatus(ctx, input.stack)),

  setEnabled: adminProcedure
    .input(z.object({ stack, enabled: z.boolean() }))
    .mutation(({ ctx, input }) => setStackEnabled(ctx, input)),

  rotateKey: adminProcedure.input(z.object({ stack })).mutation(({ ctx, input }) => rotateKey(ctx, input.stack)),

  setRateLimit: adminProcedure
    .input(z.object({ stack, perMinute: z.number().int().min(1).max(100_000) }))
    .mutation(({ ctx, input }) => setRateLimit(ctx, input.stack, input.perMinute)),

  issues: orgProcedure
    .input(
      z.object({
        stack,
        status: z.enum([...ISSUE_STATUSES, 'all']).optional(),
        query: z.string().max(200).optional(),
        release: z.string().max(200).optional(),
        sort: z.enum(['last_seen', 'first_seen', 'count', 'users']).optional(),
        limit: z.number().int().min(1).max(200).optional(),
      }),
    )
    .query(({ ctx, input }) => listIssues(ctx, input)),

  issue: orgProcedure
    .input(z.object({ stack, fingerprint, eventId: z.string().regex(/^[0-9a-f-]{32,36}$/i).optional() }))
    .query(({ ctx, input }) => issueDetail(ctx, input)),

  setIssueStatus: orgProcedure
    .input(z.object({ stack, fingerprint, status: z.enum(ISSUE_STATUSES) }))
    .mutation(({ ctx, input }) => setIssueStatus(ctx, input)),

  releases: orgProcedure
    .input(z.object({ stack, limit: z.number().int().min(1).max(200).optional() }))
    .query(({ ctx, input }) => listReleases(ctx, input)),

  /** Issues raised inside one trace — the trace view links back to them. */
  forTrace: orgProcedure
    .input(z.object({ traceId: z.string().regex(/^[0-9a-f]{32}$/i) }))
    .query(({ ctx, input }) => issuesForTrace(ctx, input.traceId)),

  /** Source maps / bundles for a release (small uploads; CLI + CI use the HTTP endpoint). */
  uploadArtifacts: adminProcedure
    .input(
      z.object({
        stack,
        release: z.string().max(200),
        files: z.array(z.object({ name: z.string().min(1).max(500), content: z.string() })).min(1).max(50),
      }),
    )
    .mutation(({ ctx, input }) => uploadArtifacts(ctx, input)),
});
