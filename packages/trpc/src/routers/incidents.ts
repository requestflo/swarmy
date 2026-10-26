import {
  IncidentNoteInput,
  IncidentRefInput,
  IncidentsListInput,
  PostIncidentUpdateInput,
  ResolveIncidentInput,
  TakeIncidentInput,
} from '@swarmy/core';
import { abacProcedure } from '../abac';
import { resolveConfigRow } from '../abac-config';
import { orgProcedure, router } from '../trpc';
import { releaseIncident, takeIncident } from '../services/incidents-owner';
import {
  addNote,
  getIncident,
  listIncidents,
  overview,
  postUpdate,
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

  /**
   * Post a public status-page update (investigating · identified · monitoring
   * · resolved). `resolved` also resolves the incident.
   */
  postUpdate: orgProcedure
    .input(PostIncidentUpdateInput)
    .mutation(({ ctx, input }) => postUpdate(ctx, input)),

  /** Reopen a resolved incident. */
  reopen: orgProcedure
    .input(IncidentRefInput)
    .mutation(({ ctx, input }) => reopenIncident(ctx, input)),

  /**
   * "Take it for 30 min": the caller has the incident for 30 minutes (again =
   * 30 more; `takeOver` takes it from whoever has it). Lapses on its own.
   * `incident.take` — members may by default.
   */
  take: abacProcedure('incident.take', resolveConfigRow('incident'))
    .input(TakeIncidentInput)
    .mutation(({ ctx, input }) => takeIncident(ctx, input)),

  /** Let go of an incident the caller has (`incident.take`). */
  release: abacProcedure('incident.take', resolveConfigRow('incident'))
    .input(IncidentRefInput)
    .mutation(({ ctx, input }) => releaseIncident(ctx, input)),
});
