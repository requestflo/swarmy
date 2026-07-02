import {
  IncidentNoteInput,
  IncidentRefInput,
  IncidentsListInput,
  ResolveIncidentInput,
} from '@swarmy/core';
import { orgProcedure, router } from '../trpc';
import {
  addNote,
  getIncident,
  listIncidents,
  overview,
  reopenIncident,
  resolveIncidentManually,
} from '../services/incidents.service';

/**
 * Incidents (slice C4) — open/resolve lifecycle, event timeline, post-mortem
 * notes. Timelines are written by automation through `incidents-record.ts`
 * (alert-evaluator, db failover, deploy safety); this surface is the human
 * side: read the story, annotate it, close it, reopen it.
 */
export const incidentsRouter = router({
  /** Aggregates for the Incidents page hero (open / critical / resolved 7d). */
  overview: orgProcedure.query(({ ctx }) => overview(ctx)),

  /** Incidents, open first then newest; optionally filtered to one status. */
  list: orgProcedure.input(IncidentsListInput).query(({ ctx, input }) => listIncidents(ctx, input)),

  /** One incident with its full timeline (oldest event first). */
  get: orgProcedure.input(IncidentRefInput).query(({ ctx, input }) => getIncident(ctx, input)),

  /** Append a manual `note` event to the timeline. */
  addNote: orgProcedure.input(IncidentNoteInput).mutation(({ ctx, input }) => addNote(ctx, input)),

  /** Manually resolve an open incident (optional resolution message). */
  resolve: orgProcedure
    .input(ResolveIncidentInput)
    .mutation(({ ctx, input }) => resolveIncidentManually(ctx, input)),

  /** Reopen a resolved incident. */
  reopen: orgProcedure
    .input(IncidentRefInput)
    .mutation(({ ctx, input }) => reopenIncident(ctx, input)),
});
