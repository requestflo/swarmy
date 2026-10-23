import type { AlertDiskHistoryView } from '@swarmy/core';
import type { DomainResolvers } from '../types';
import { DEMO_DISK_PCT } from './core';

/**
 * `alerts.diskHistory` demo: a week of 5-minute disk peaks per server, the
 * same story as the alert feed (alerts.ts) and the Servers page (core.ts).
 * wkr-1 runs hot: it crept past 85% four days ago and stayed above for three
 * hours (86.3% at the peak) until a cleanup, then grew again to today's 81%.
 * wkr-3's hour offline 26 h ago is a gap — no samples, never a zero. Every
 * other server sits near today's reading.
 */

const STEP_S = 300;
const SLOTS = (7 * 86_400) / STEP_S;
const HOUR = 3_600_000;

/** Deterministic wobble in [-0.2, 0.2] per server and slot. */
const wobble = (key: string, i: number): number => (((i * 37 + key.length * 11) % 21) - 10) / 50;

function wkr1(hoursAgo: number): number {
  if (hoursAgo >= 96) return 80 + (168 - hoursAgo) * (4.6 / 72);
  if (hoursAgo >= 93) return 85.5 + (96 - hoursAgo) * 0.27;
  return 77.2 + (93 - hoursAgo) * (3.8 / 93);
}

const diskHistory = (input: unknown, s: { nodes: Array<{ id: string; name: string }> }): AlertDiskHistoryView => {
  const server = (input as { server?: string } | undefined)?.server;
  const now = Date.now();
  const from = (Math.floor(now / 1000 / STEP_S) - SLOTS + 1) * STEP_S * 1000;
  const servers = s.nodes
    .filter((n) => !server || n.name === server)
    .map((n) => ({
      name: n.name,
      peaks: Array.from({ length: SLOTS }, (_, i) => {
        const hoursAgo = (now - (from + i * STEP_S * 1000)) / HOUR;
        if (n.name === 'wkr-3' && hoursAgo <= 26 && hoursAgo > 25) return null;
        const base = n.name === 'wkr-1' ? wkr1(hoursAgo) : (DEMO_DISK_PCT[n.id] ?? 42) - hoursAgo * 0.004;
        return Math.round((base + (n.name === 'wkr-1' && hoursAgo >= 93 && hoursAgo < 96 ? 0 : wobble(n.id, i))) * 10) / 10;
      }),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
  return { from: new Date(from).toISOString(), stepSeconds: STEP_S, servers };
};

export const alertsDisk: DomainResolvers = {
  handlers: { 'alerts.diskHistory': diskHistory },
};
