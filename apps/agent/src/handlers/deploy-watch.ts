/**
 * Deploy watch: after the manager creates/updates a traced service, follow
 * its tasks for a bounded time and stream `deployProgress` frames (the
 * Deploying screen's pull/data/start stages). Best-effort by contract:
 * the deploy command has already answered, nothing here throws, and a
 * failed read just skips a beat.
 *
 * Where the image lands: the swarm pulls on the task's node. When that node
 * is THIS one, the watcher follows the same pull through the daemon (Docker
 * de-duplicates concurrent downloads of a layer, so it costs nothing extra)
 * to report layers, bytes and the verified digest. On another node it
 * reports the task's own states (preparing = pulling, starting, running).
 *
 * Every message is display-safe: image refs, service/node names, counts,
 * the task's Docker state and its error line. Never env or credentials.
 */
import type { PullProgressEvent } from '@swarmy/core/docker';
import type { DeployProgressPayload, DeployStage, DeployWatch } from '@swarmy/core/protocol';
import { foldLayerEvent, layerSummary, newLayerTally, pullProgressLine, shortDigest } from './deploy-layers';

export interface WatchTask {
  nodeId: string;
  /** Docker task state: new … preparing, starting, running, failed, rejected … */
  state: string;
  desired: string;
  createdAt: number;
  err?: string;
}

export interface DeployWatchDeps {
  tasks(service: string): Promise<WatchTask[]>;
  localNodeId(): Promise<string>;
  nodeName(swarmNodeId: string): Promise<string>;
  /** Follow a pull of `image` through the local daemon (auth bound by the caller). */
  pull(image: string, onEvent: (e: PullProgressEvent) => void): Promise<string>;
  send(p: DeployProgressPayload): void;
  now(): number;
  sleep(ms: number): Promise<void>;
}

export interface DeployWatchInput {
  watch: DeployWatch;
  service: string;
  image: string;
  /** Replicas wanted (null = global: every scheduled task). */
  desired: number | null;
  /** Named volumes it mounts (reported once it runs, for data). */
  volumes: string[];
  /** When the deploy command arrived: tasks created since are this deploy's. */
  since?: number;
}

const PULLING = new Set(['assigned', 'accepted', 'preparing']);
const STARTED = new Set(['ready', 'starting', 'running']);
const BROKE = new Set(['failed', 'rejected']);

/** `localhost:5000/acme/ghost:5.96-alpine@sha256:…` → `ghost:5.96-alpine`. */
export const displayImage = (ref: string): string => (ref.split('@')[0] ?? ref).split('/').pop() ?? ref;
const clip = (s: string): string => (s.length > 300 ? `${s.slice(0, 299)}…` : s);

export async function watchDeploy(
  deps: DeployWatchDeps,
  input: DeployWatchInput,
  opts: { maxMs?: number; pollMs?: number; throttleMs?: number; settleMs?: number } = {},
): Promise<void> {
  const { watch, service, image } = input;
  const maxMs = opts.maxMs ?? 600_000;
  const pollMs = opts.pollMs ?? 1_000;
  const throttleMs = opts.throttleMs ?? 500;
  const settleMs = opts.settleMs ?? 15_000;
  const data = watch.role === 'data';
  const t0 = deps.now();
  const img = displayImage(image);
  const local = await deps.localNodeId().catch(() => '');
  const here = await deps.nodeName(local).catch(() => 'this server');
  const names = new Map<string, string>();
  const nameOf = async (id: string): Promise<string> => {
    if (!names.has(id)) names.set(id, await deps.nodeName(id).catch(() => id.slice(0, 12)));
    return names.get(id) ?? id;
  };
  const say = (stage: DeployStage, status: DeployProgressPayload['status'], node: string, message: string, detail?: DeployProgressPayload['detail']): void => {
    try {
      // A companion folds into the data stage: only its first line starts it,
      // only "running" finishes it; everything between is progress.
      const st = !data || status === 'failed' || stage === 'data' ? status : stage === 'start' && status === 'done' ? 'done' : 'progress';
      deps.send({ deployId: watch.deployId, stack: watch.stack, service, node, stage: data ? 'data' : stage, status: st, at: deps.now(), message: clip(message), ...(detail ? { detail } : {}) });
    } catch {
      /* best-effort */
    }
  };

  let pullSaid = false;
  let pullDone = false;
  let observing = false;
  let startSaid = false;
  const errs = new Set<string>();
  if (data) say('data', 'started', here, `${service} 0/${input.desired ?? 1} → scheduling`, { image });

  const observe = (node: string): void => {
    observing = true;
    const tally = newLayerTally();
    let last = 0;
    deps
      .pull(image, (e) => {
        foldLayerEvent(tally, e);
        const t = deps.now();
        if (t - last < throttleMs) return;
        last = t;
        const s = layerSummary(tally);
        say('pull', 'progress', node, pullProgressLine(img, s), { ...s, image });
      })
      .then((digest) => {
        if (pullDone) return;
        pullDone = true;
        const s = layerSummary(tally);
        const valid = /^sha256:[a-f0-9]{64}$/.test(digest);
        const what = valid ? `digest ${shortDigest(digest)} verified` : `${img} is on ${node}`;
        say('pull', 'done', node, tally.upToDate ? `${img} already on ${node} · ${what}` : what, { ...s, image, ...(valid ? { digest } : {}) });
      })
      .catch(() => {
        observing = false; // the swarm's own pull decides; its task state reports it
      });
  };

  while (deps.now() - t0 < maxMs) {
    const all = await deps.tasks(service).catch(() => null);
    if (all) {
      const fresh = all.filter((t) => t.createdAt >= (input.since ?? t0) - 2_000);
      const current = fresh.filter((t) => t.desired === 'running');
      const running = all.filter((t) => t.desired === 'running' && t.state === 'running').length;
      const want = input.desired ?? Math.max(1, current.length);
      const lead = current[0];
      const node = lead ? await nameOf(lead.nodeId) : here;

      if (lead && !pullSaid && (PULLING.has(lead.state) || STARTED.has(lead.state))) {
        pullSaid = true;
        say('pull', 'started', node, `pulling ${img} on ${node}`, { image });
        if (lead.nodeId === local && !data) observe(node);
      }
      if (lead && STARTED.has(lead.state) && !pullDone && !observing) {
        pullDone = true;
        say('pull', 'done', node, `${img} is on ${node}`, { image });
      }
      if (lead && STARTED.has(lead.state) && !startSaid) {
        startSaid = true;
        say('start', 'started', node, `${service} ${running}/${want} → starting`, { replicasRunning: running, replicasDesired: want });
      }
      for (const t of fresh) {
        const err = t.err?.trim();
        if (!BROKE.has(t.state) || !err || errs.has(err)) continue;
        errs.add(err);
        say(pullDone ? 'start' : 'pull', 'failed', await nameOf(t.nodeId), `${service}: ${err}`);
      }
      const settled = fresh.length === 0 && deps.now() - t0 >= settleMs;
      if (running >= want && (current.some((t) => t.state === 'running') || settled)) {
        for (const v of data ? input.volumes : []) say('data', 'progress', node, `volume ${v} mounted on ${node}`);
        say('start', 'done', node, `${service} ${running}/${want} running${settled ? ' · unchanged' : ''}`, { replicasRunning: running, replicasDesired: want });
        return;
      }
    }
    await deps.sleep(pollMs);
  }
}
