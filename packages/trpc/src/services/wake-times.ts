/**
 * Cold-start samples for scale-to-zero services (board 34), in controller
 * memory: the activator (apps/api `activator.ts`) records each real wake —
 * request in → visitor sent back to a running copy — and Config › Scaling
 * reads the summary. WHY memory, not a table: a wake time is only worth the
 * last few samples, it says how this controller's waker behaves now, and no
 * history table fits it (telemetry.db holds metrics series, not events like
 * this). A restart starts the samples over; the page then says it hasn't
 * timed a wake yet, never a made-up number.
 */
import { keepWakeSamples, wakeTimesView, type WakeSample, type WakeTimesView } from '@swarmy/core';
import type { OrgContext } from '../context';
import { notFound } from '../errors';
import { liveService } from './service.service';

const samples = new Map<string, WakeSample[]>();
const key = (orgId: string, service: string): string => `${orgId}\u0000${service}`;

/** One measured wake of `service` (its Docker service name) in `orgId`. */
export function recordWakeTime(orgId: string, service: string, ms: number, at = Date.now()): void {
  if (!Number.isFinite(ms) || ms < 0) return;
  const k = key(orgId, service);
  samples.set(k, keepWakeSamples(samples.get(k) ?? [], { at, ms: Math.round(ms) }));
}

/** The wake summary for a service name (no ctx: the activator and tests use it). */
export function wakeTimesFor(orgId: string, service: string): WakeTimesView {
  return wakeTimesView(samples.get(key(orgId, service)) ?? []);
}

/** services.wakeTimes — the picked service's recent wakes, org-scoped through the live inventory. */
export function serviceWakeTimes(ctx: OrgContext, id: string): WakeTimesView {
  const svc = liveService(ctx, id);
  if (!svc) throw notFound('service', id);
  return wakeTimesFor(ctx.activeOrgId, svc.name);
}

/** Test seam. */
export function _resetWakeTimes(): void {
  samples.clear();
}
