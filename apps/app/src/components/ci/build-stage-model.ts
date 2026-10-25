import type { Tone } from '@/components/calm';
import { repoName } from './builds-list';

/** A stage as `cicd.getBuild` returns it. */
export interface StageLike {
  key: 'clone' | 'build' | 'push' | 'scan' | 'sign' | 'rollout';
  startedAt: string;
  finishedAt: string | null;
  outcome: 'running' | 'ok' | 'warn' | 'failed';
  facts: {
    error?: string;
    scan?: { critical: number; high: number; medium: number; low: number };
    rollout?: { stack: string; services: string[]; ready: number; desired: number; drained?: boolean };
  };
}

export interface BuildLike {
  status: string;
  repoUrl: string;
  commit: string | null;
  image: string | null;
  startedAt: string | null;
  builder: string | null;
  cachedSteps: number | null;
  stages: StageLike[];
  usualMs?: Partial<Record<StageLike['key'], number>>;
  /** "v1.4.0" when the tag or release names one (`cicd.getBuild`); else the short commit stands in. */
  version?: string | null;
}

export interface StageRowView {
  key: StageLike['key'];
  label: string;
  tone: Tone;
  state: 'done' | 'running' | 'failed' | 'pending';
  /** "38 s · usually 41 s", "31 s · usually 41 s" while it runs, "—" before. */
  time: string;
  detail: string | null;
}

export const LABEL: Record<StageLike['key'], string> = { clone: 'Clone', build: 'Build', push: 'Push', scan: 'Scan', sign: 'Sign', rollout: 'Roll out' };
const RUNNING = new Set(['queued', 'building', 'pushing']);

/** 2 s · 38 s · 1 m 04 s */
export function durationWords(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  return s < 60 ? `${s} s` : `${Math.floor(s / 60)} m ${String(s % 60).padStart(2, '0')} s`;
}

function detailOf(b: BuildLike, s: StageLike | undefined, key: StageLike['key']): string | null {
  if (s?.facts.error) return s.facts.error;
  const scan = s?.facts.scan;
  const roll = s?.facts.rollout;
  switch (key) {
    case 'clone':
      return [repoName(b.repoUrl), b.commit?.slice(0, 7)].filter(Boolean).join(' @ ');
    case 'build':
      return b.builder ? [b.builder === 'railpack' ? 'Railpack' : 'Dockerfile', b.cachedSteps ? `${b.cachedSteps} steps from cache` : null].filter(Boolean).join(' · ') : null;
    case 'push':
      return b.image ? `${b.image.split('/')[0]} · in your swarm` : null;
    case 'scan':
      return scan ? `${scan.critical} critical · ${scan.high} high · ${scan.medium} medium · ${scan.low} low` : 'Trivy · vulnerabilities by severity';
    case 'sign':
      return s?.outcome === 'ok' ? 'cosign · signed with your key' : 'cosign';
    case 'rollout':
      return roll ? `${roll.ready} of ${roll.desired} copies running on ${roll.services.join(', ') || roll.stack}` : null;
  }
}

/**
 * The rail: the stages swarmy recorded, plus — while the build still runs —
 * the builder's stages and the scan it always runs next (shown as not yet).
 * Sign and roll out appear only once they happen (not every org signs, not
 * every build deploys).
 */
export function stageRows(b: BuildLike, now: number): StageRowView[] {
  const recorded = new Map(b.stages.map((s) => [s.key, s]));
  const keys = (['clone', 'build', 'push', 'scan', 'sign', 'rollout'] as const).filter(
    (k) => recorded.has(k) || (RUNNING.has(b.status) && b.stages.length > 0 && ['clone', 'build', 'push', 'scan'].includes(k)),
  );
  return keys.map((key) => {
    const s = recorded.get(key);
    const usual = b.usualMs?.[key];
    const tail = usual !== undefined ? ` · usually ${durationWords(usual)}` : '';
    const state: StageRowView['state'] = !s ? 'pending' : s.outcome === 'running' ? 'running' : s.outcome === 'failed' ? 'failed' : 'done';
    const tone: Tone = state === 'pending' ? 'idle' : state === 'running' ? 'info' : state === 'failed' ? 'bad' : s?.outcome === 'warn' ? 'warn' : 'ok';
    const end = s?.finishedAt ? Date.parse(s.finishedAt) : now;
    const time = s ? `${durationWords(end - Date.parse(s.startedAt))}${tail}` : '—';
    return { key, label: LABEL[key], tone, state, time, detail: detailOf(b, s, key) };
  });
}

export interface OutcomeView {
  tone: Tone;
  title: string;
  /** "1 m 04 s total · health 3/3 · previous copy drained" — only the parts swarmy knows. */
  meta: string;
  /** The app it went to, when the swarm showed it (links to its canvas). */
  stack: string | null;
}

/** The line under the log once the deploy that followed has settled. */
export function outcomeLine(b: BuildLike): OutcomeView | null {
  const r = b.stages.find((s) => s.key === 'rollout');
  if (!r?.finishedAt || r.outcome === 'running') return null;
  const roll = r.facts.rollout;
  const who = b.version ?? (b.commit && /^[0-9a-f]{7,}$/.test(b.commit) ? b.commit.slice(0, 7) : 'This build');
  const where = roll ? ` on ${roll.services.join(', ') || roll.stack}` : '';
  const health = roll ? `health ${roll.ready}/${roll.desired}` : null;
  if (r.outcome === 'failed') {
    const meta = [r.facts.error, health].filter(Boolean).join(' · ');
    return { tone: 'bad', title: `${who} didn’t roll out${where}`, meta, stack: roll?.stack ?? null };
  }
  if (!roll) return null;
  const first = Math.min(...b.stages.map((s) => Date.parse(s.startedAt)), b.startedAt ? Date.parse(b.startedAt) : Infinity);
  const meta = [`${durationWords(Date.parse(r.finishedAt) - first)} total`, health, roll.drained ? 'previous copy drained' : null];
  return { tone: 'ok', title: `${who} is live${where}`, meta: meta.filter(Boolean).join(' · '), stack: roll.stack };
}
