/**
 * Editing preview rules (board 68) — PURE. The form's choices ↔ the
 * `previews:` block as swarmy.yaml writes it. The same block is what the
 * dashboard saves when the file has none (`apps.setPreviewRules`) and the
 * YAML shown to paste when the file has one: there is one shape.
 */
import { PreviewsSchema, type PreviewsInput, type SizePreset } from '@swarmy/app-config';
import type { PreviewRules } from '../gitops-types';
import { duration, PREVIEW_SLEEP_DEFAULT_SECONDS, yamlDuration } from './previews-model';

export type BranchesChoice = 'off' | 'prs' | 'branches';
export type DataChoice = 'empty' | 'copy';

export interface RulesDraft {
  branches: BranchesChoice;
  /** `feature/*, release/**` — only with `branches`. */
  patterns: string;
  /** Seconds after the last push; 0 = until the branch or PR goes. */
  keep: number;
  /** Seconds idle before it sleeps; -1 = never. */
  sleep: number;
  data: DataChoice;
  /** A .sql file in the repo run on the copy (blank = an unmasked copy). */
  scrub: string;
  /** A size preset cap; '' = what the app asks for. */
  size: string;
  baseDomain: string;
  shared: boolean;
}

export const NEVER = -1;
const D = 86_400;
const KEEP = [{ value: D, label: '24 h' }, { value: 3 * D, label: '3 d' }, { value: 7 * D, label: '7 d' }, { value: 0, label: 'Until closed' }];
const SLEEP = [{ value: 1800, label: '30 min' }, { value: 2 * 3600, label: '2 h' }, { value: 8 * 3600, label: '8 h' }, { value: NEVER, label: 'Never' }];
/** "Until closed" / "Never" (0 / -1) sort last. */
const order = (v: number): number => (v <= 0 ? Infinity : v);
/** The presets, plus the current value when it is none of them (a `ttl: 48h` from the file). */
const withCurrent = (opts: Array<{ value: number; label: string }>, v: number) =>
  opts.some((o) => o.value === v) ? opts : [...opts, { value: v, label: duration(v) }].sort((a, b) => order(a.value) - order(b.value));

export const keepOptions = (v: number) => withCurrent(KEEP, v);
export const sleepOptions = (v: number) => withCurrent(SLEEP, v);
export const SIZE_OPTIONS: Array<{ value: string; label: string }> = [
  { value: '', label: 'As the app asks' },
  { value: 'nano', label: 'nano' },
  { value: 'small', label: 'small' },
  { value: 'medium', label: 'medium' },
];

export function draftFrom(r: PreviewRules | null | undefined): RulesDraft {
  const sleep = r?.sleepAfterSeconds === undefined ? PREVIEW_SLEEP_DEFAULT_SECONDS : (r.sleepAfterSeconds ?? NEVER);
  return {
    branches: !r?.enabled ? 'off' : r.branches.length ? 'branches' : 'prs',
    patterns: (r?.branches.length ? r.branches : ['feature/*']).join(', '),
    keep: r?.ttlSeconds ?? 3 * D,
    sleep,
    data: r?.data ? 'copy' : 'empty',
    scrub: r?.data?.scrub ?? '',
    size: r?.size ?? '',
    baseDomain: r?.baseDomain ?? '',
    shared: r?.resources === 'shared',
  };
}

const list = (s: string): string[] => s.split(/[\s,]+/).map((x) => x.trim()).filter(Boolean);

/** The `previews:` block the choices make (swarmy.yaml keys). */
export function blockOf(d: RulesDraft): PreviewsInput {
  const patterns = list(d.patterns);
  return {
    enabled: d.branches !== 'off',
    ...(d.baseDomain.trim() ? { base_domain: d.baseDomain.trim() } : {}),
    ...(d.branches === 'branches' && patterns.length ? { branches: patterns } : {}),
    ttl: d.keep ? yamlDuration(d.keep) : 0,
    sleep_after: d.sleep === NEVER ? 'never' : yamlDuration(d.sleep),
    ...(d.shared ? { resources: 'shared' } : d.data === 'copy' ? { data: { from: 'production', ...(d.scrub.trim() ? { scrub: d.scrub.trim() } : {}) } } : {}),
    ...(d.size ? { size: d.size as SizePreset } : {}),
  };
}

/** What's wrong with the choices, in plain words (null = good to save). */
export function draftProblem(d: RulesDraft): string | null {
  if (d.branches !== 'off' && !d.baseDomain.trim()) return 'Previews need an address to live under — set the preview domain.';
  if (d.branches === 'branches' && !list(d.patterns).length) return 'Name at least one branch pattern, like feature/*.';
  const parsed = PreviewsSchema.safeParse(blockOf(d));
  if (!parsed.success) {
    const i = parsed.error.issues[0];
    return `${i?.path.join('.') || 'previews'}: ${i?.message ?? 'not valid'}`;
  }
  return null;
}
