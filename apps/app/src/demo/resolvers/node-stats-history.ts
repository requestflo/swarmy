import {
  NODE_STATS_HISTORY_SLOTS as SLOTS,
  NODE_STATS_HISTORY_STEP_SECONDS as STEP_S,
  type NodeStatsHistoryView,
} from '@swarmy/core';
import type { DemoStore, DomainResolvers } from '../types';
import { DEMO_DISK_PCT } from './core';

/**
 * `nodes.statsHistory` demo: 24 h of 5-minute peaks per server, anchored on
 * the live numbers the Servers page shows (each node's `live` CPU / memory
 * and DEMO_DISK_PCT). CPU follows the working day (quietest around 04:00
 * UTC, busiest mid-afternoon) with short spikes; memory drifts gently; disk
 * creeps up — wkr-1 from 80% to today's 81%, as the disk backtest tells it.
 * wkr-3 started draining 3 h ago, so its CPU settles at today's low there.
 * A server with no live numbers (offline) has no history here either.
 */

const HOUR = 3_600_000;

/** Deterministic noise in [0, 1) per key and slot. */
function unit(key: string, i: number): number {
  let h = 0x811c9dc5 ^ i;
  for (let c = 0; c < key.length; c++) h = Math.imul(h ^ key.charCodeAt(c), 0x01000193);
  return (h >>> 0) / 0x1_0000_0000;
}

/** 0.55 at 04:00 UTC → 1 mid-afternoon. */
function day(t: number): number {
  const d = new Date(t);
  const hour = d.getUTCHours() + d.getUTCMinutes() / 60;
  return 0.775 + 0.225 * Math.sin(((hour - 10) / 24) * 2 * Math.PI);
}

const r1 = (n: number): number => Math.round(Math.max(0, Math.min(100, n)) * 10) / 10;

function statsHistory(input: unknown, s: DemoStore): NodeStatsHistoryView {
  const nodeId = (input as { nodeId?: string } | undefined)?.nodeId;
  const now = Date.now();
  const from = (Math.floor(now / 1000 / STEP_S) - SLOTS + 1) * STEP_S * 1000;
  const servers = s.nodes
    .filter((n) => n.live && (!nodeId || n.id === nodeId))
    .map((n) => {
      const live = n.live!;
      const cpu: number[] = [];
      const mem: number[] = [];
      const disk: number[] = [];
      for (let i = 0; i < SLOTS; i++) {
        const t = from + i * STEP_S * 1000;
        const hoursAgo = (now - t) / HOUR;
        // ±12 points around today's reading through the day, a short spike now and then.
        const swing = (12 * (day(t) - day(now))) / 0.45;
        const spike = unit(`${n.id}:spike`, i) > 0.96 ? 9 + 6 * unit(`${n.id}:size`, i) : 0;
        const busy = live.cpuPercent + swing + spike + 4 * (unit(n.id, i) - 0.5);
        cpu.push(r1(n.status === 'draining' && hoursAgo < 3 ? live.cpuPercent + 2 * unit(n.id, i) : busy));
        mem.push(r1(live.memPercent - hoursAgo * 0.05 + 2 * unit(`${n.id}:mem`, i)));
        const diskNow = DEMO_DISK_PCT[n.id] ?? 42;
        disk.push(r1(diskNow - hoursAgo * (n.name === 'wkr-1' ? 1 / 24 : 0.01) + 0.2 * unit(`${n.id}:disk`, i)));
      }
      return { nodeId: n.id, name: n.name, cpu, mem, disk };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
  return { from: new Date(from).toISOString(), stepSeconds: STEP_S, fold: 'peak', servers };
}

export const nodeStatsHistory: DomainResolvers = {
  handlers: { 'nodes.statsHistory': statsHistory },
};
