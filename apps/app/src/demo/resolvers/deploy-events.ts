import type { DeployProgressPayload } from '@swarmy/core/protocol';
import type { DemoStore, DomainResolvers } from '../types';
import { CERT_READY, DATA_READY, DATA_START, MAIN_READY, MAIN_START, type DemoDeployPart } from './blueprint-deploys';

/**
 * The demo's traced deploys: `deploys.get` + the `deploys.events` stream,
 * on the same clock as blueprint-deploys.ts (data ready ~6 s, the app ~10 s,
 * its certificate ~13 s), so the tracker, the log and the polled inventory
 * tell one story. The lines are the ones the agent and controller send.
 */

type Ev = DeployProgressPayload & { seq: number };
interface DemoTrace {
  deployId: string;
  stack: string;
  at: number;
  events: Array<{ t: number; e: Omit<Ev, 'at' | 'seq'> }>;
}

const traces = (s: DemoStore): DemoTrace[] => ((s.extra.demoDeployTraces ??= []) as DemoTrace[]);

/** A stable pseudo-random number per string (layer counts, sizes, digests). */
function hash(x: string): number {
  let h = 2166136261;
  for (const c of x) h = Math.imul(h ^ c.charCodeAt(0), 16777619) >>> 0;
  return h;
}
const hex64 = (x: string): string => Array.from({ length: 8 }, (_, i) => hash(`${x}:${i}`).toString(16).padStart(8, '0')).join('');
const img = (ref: string): string => ref.split('/').pop() ?? ref;
const DATAY = /mysql|mariadb|postgres|redis|valkey|mongo|meili/;

export function startDemoTrace(
  s: DemoStore,
  x: { stack: string; parts: DemoDeployPart[]; host: string | null; dataSteps: string[]; node: string },
): string {
  const deployId = `dep_${hex64(`${x.stack}${Date.now()}`).slice(0, 20)}`;
  const ev: DemoTrace['events'] = [];
  const at = (t: number, e: Omit<Ev, 'at' | 'seq' | 'deployId' | 'stack'>): void => void ev.push({ t, e: { deployId, stack: x.stack, ...e } });
  const n = x.node;
  x.dataSteps.forEach((label, i) => {
    const service = `${x.stack}:step:${i}`;
    at(200 + i * 400, { node: 'swarmy', stage: 'data', status: 'started', service, message: label });
    const done = /secret/i.test(label) ? `${label.replace(/^Generate secret /i, 'secret ')} generated · stored as a Docker secret` : `${label} · done`;
    at(500 + i * 400, { node: 'swarmy', stage: 'data', status: 'done', service, message: done });
  });
  for (const p of x.parts.filter((q) => !q.main)) {
    const service = `${x.stack}_${p.name}`;
    at(300, { node: n, stage: 'data', status: 'started', service, message: `${service} 0/1 → scheduling` });
    at(900, { node: n, stage: 'data', status: 'progress', service, message: `pulling ${img(p.image)} on ${n}` });
    at(DATA_START, { node: n, stage: 'data', status: 'progress', service, message: `${service} 0/1 → starting` });
    if (DATAY.test(p.image)) at(DATA_READY - 50, { node: n, stage: 'data', status: 'progress', service, message: `volume ${service}-data mounted on ${n}` });
    at(DATA_READY, { node: n, stage: 'data', status: 'done', service, message: `${service} 1/1 running`, detail: { replicasRunning: 1, replicasDesired: 1 } });
  }
  const main = x.parts.find((q) => q.main) ?? x.parts[0];
  if (main) {
    const service = `${x.stack}_${main.name}`;
    const image = img(main.image);
    const layers = 5 + (hash(image) % 5);
    const bytes = 60_000_000 + (hash(`${image}:b`) % 120_000_000);
    at(500, { node: n, stage: 'pull', status: 'started', service, message: `pulling ${image} on ${n}`, detail: { image } });
    for (let t = 900, i = 0; t < 4_200; t += 500, i++) {
      const frac = Math.min(1, (i + 1) / 7);
      const done = Math.floor(layers * frac * 0.95);
      const bytesDone = Math.round(bytes * frac);
      at(t, { node: n, stage: 'pull', status: 'progress', service, message: `${image}: ${done} of ${layers} layers · ${Math.round(bytesDone / 1e6)} of ${Math.round(bytes / 1e6)} MB`, detail: { layersTotal: layers, layersDone: done, bytesTotal: bytes, bytesDone, image } });
    }
    const digest = `sha256:${hex64(image)}`;
    at(4_300, { node: n, stage: 'pull', status: 'done', service, message: `digest sha256:${digest.slice(7, 11)}…${digest.slice(-4)} verified`, detail: { layersTotal: layers, layersDone: layers, bytesTotal: bytes, bytesDone: bytes, digest, image } });
    at(MAIN_START, { node: n, stage: 'start', status: 'started', service, message: `${service} 0/1 → starting`, detail: { replicasRunning: 0, replicasDesired: 1 } });
    at(MAIN_READY, { node: n, stage: 'start', status: 'done', service, message: `${service} 1/1 running`, detail: { replicasRunning: 1, replicasDesired: 1 } });
  }
  const all = `${x.parts.length}/${x.parts.length} services running`;
  if (x.host) {
    at(1_200, { node: 'swarmy', stage: 'route', status: 'started', message: `route https://${x.host} added`, detail: { host: x.host } });
    at(MAIN_START + 300, { node: 'swarmy', stage: 'route', status: 'progress', message: `asking Let’s Encrypt for ${x.host}`, detail: { host: x.host } });
    at(CERT_READY, { node: 'swarmy', stage: 'route', status: 'done', message: `certificate for ${x.host} issued by R11`, detail: { host: x.host } });
  }
  at(MAIN_READY + 100, { node: 'swarmy', stage: 'health', status: 'started', message: x.host ? `checking ${all} and ${x.host}` : `checking ${all}` });
  at(x.host ? CERT_READY + 200 : MAIN_READY + 300, { node: 'swarmy', stage: 'health', status: 'done', message: x.host ? `${all} · ${x.host} answering` : `${all} · it’s live` });
  ev.sort((a, b) => a.t - b.t);
  traces(s).push({ deployId, stack: x.stack, at: Date.now(), events: ev });
  return deployId;
}

const stamp = (tr: DemoTrace, i: number): Ev => ({ ...tr.events[i]!.e, at: tr.at + tr.events[i]!.t, seq: i + 1 }) as Ev;
const find = (s: DemoStore, i: unknown): DemoTrace => {
  const tr = traces(s).find((x) => x.deployId === (i as { deployId: string }).deployId);
  if (!tr) throw new Error('deploy not found');
  return tr;
};

export const deployEvents: DomainResolvers = {
  handlers: {
    'deploys.get': (i, s) => {
      const tr = find(s, i);
      const now = Date.now() - tr.at;
      const events = tr.events.map((_, k) => stamp(tr, k)).filter((_, k) => tr.events[k]!.t <= now);
      return { deployId: tr.deployId, stack: tr.stack, startedAt: tr.at, done: events.length === tr.events.length, events };
    },
  },
  subscriptions: {
    'deploys.events': (i, s, emit) => {
      const tr = traces(s).find((x) => x.deployId === (i as { deployId: string }).deployId);
      if (!tr) return () => undefined;
      const now = Date.now() - tr.at;
      const timers = tr.events.map((ev, k) => setTimeout(() => emit(stamp(tr, k)), Math.max(0, ev.t - now)));
      return () => timers.forEach(clearTimeout);
    },
  },
};
