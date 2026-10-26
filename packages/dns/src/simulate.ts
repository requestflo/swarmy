import type { Answer, Question } from 'dns-packet';
import type { DnsZoneSnapshot } from '@swarmy/core/protocol';
import { answerQuery } from './answer';
import { regionCoord, type ClientLocation } from './steer';

/**
 * "What if this front door went down?" (board 32) — pure and read-only. Runs
 * the real answering engine (`answerQuery`, whose geo answers come from
 * `steer`) for a host's A query from each visitor region twice: against the
 * zones as they are, and against a copy with the chosen edges marked
 * unhealthy, exactly as the controller marks a node that went offline. The
 * zones passed in are never changed and nothing is pushed anywhere.
 */

export interface DownOutcome {
  /** The region asked from (a `swarmy.region` label or continent prefix). */
  from: string;
  /** Addresses answered today, nearest first. */
  before: string[];
  /** Addresses answered with the edges down, nearest first. */
  after: string[];
  /** With the edges down nothing healthy is left, so everyone is answered (degraded beats dark). */
  degraded: boolean;
  /** The engine placed the visitor (false: answered in a fixed order). */
  steered: boolean;
}

/** A visitor asking from a region label, placed where the engine places it (as `geodns.previewResolution` does). */
export function clientInRegion(region: string): ClientLocation {
  return { coord: regionCoord(region), region };
}

/** A copy of the zones with every geo endpoint at one of `ips` unhealthy. */
export function markEdgesDown(zones: readonly DnsZoneSnapshot[], ips: readonly string[]): DnsZoneSnapshot[] {
  const down = new Set(ips);
  return zones.map((z) => ({
    ...z,
    geoRecords: z.geoRecords.map((g) => ({
      ...g,
      endpoints: g.endpoints.map((e) => (down.has(e.ip) ? { ...e, healthy: false } : e)),
    })),
  }));
}

function addresses(answers: Answer[]): string[] {
  return answers.flatMap((a) => (a.type === 'A' && typeof a.data === 'string' ? [a.data] : []));
}

/** Per visitor region: who answers `host` now, and who would with the edges at `ips` down. */
export function simulateEdgesDown(
  zones: readonly DnsZoneSnapshot[],
  host: string,
  ips: readonly string[],
  from: readonly string[],
): DownOutcome[] {
  const now = [...zones];
  const then = markEdgesDown(zones, ips);
  const question = { name: host, type: 'A' } as Question;
  return from.map((region) => {
    const client = clientInRegion(region);
    const before = answerQuery(now, question, client);
    const after = answerQuery(then, question, client);
    return {
      from: region,
      before: addresses(before.answers),
      after: addresses(after.answers),
      degraded: after.degraded,
      steered: after.steered,
    };
  });
}
