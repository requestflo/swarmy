import { AuditExportInput, AuditQueryInput, SetAuditRetentionInput } from '@swarmy/core';
import { adminProcedure, orgProcedure, router } from '../trpc';
import {
  exportAudit,
  getFacets,
  getRetention,
  queryAudit,
  setRetention,
} from '../services/auditLog.service';

/**
 * Audit pack (slice E5) — mounted as `audit`. Filterable/cursor-paginated
 * timeline over the org's AuditLog, filter facets, CSV/JSON export (also on
 * REST: `GET /api/v1/audit/export`) and the retention setting the retention
 * worker prunes by.
 */
export const auditLogRouter = router({
  /** The timeline: actor/action-prefix/resource/date filters, newest first. */
  list: orgProcedure.input(AuditQueryInput).query(({ ctx, input }) => queryAudit(ctx, input)),

  /** Distinct actions / actor types / actors for the filter dropdowns (60s cache). */
  facets: orgProcedure.query(({ ctx }) => getFacets(ctx)),

  /** Render the filtered log to a downloadable CSV/JSON string (≤10k rows, audited). */
  export: orgProcedure.input(AuditExportInput).mutation(({ ctx, input }) => exportAudit(ctx, input)),

  /** The org's audit retention window (default 365 days). */
  retention: orgProcedure.query(({ ctx }) => getRetention(ctx)),

  /** Change the retention window (admin/owner only, audited). */
  setRetention: adminProcedure
    .input(SetAuditRetentionInput)
    .mutation(({ ctx, input }) => setRetention(ctx, input)),
});
