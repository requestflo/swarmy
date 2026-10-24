/**
 * Pure helpers for "Here's what we found" (board 24): the header words, the
 * chips, the swarmy.yaml split into lines for the read-only view, and the
 * Build · advanced text fields ↔ the schema's `build:` keys.
 */
import type { GitChipTone } from './git-chip';
import type { AppGraph, BuildOptions, Detection, DetectionKind } from './git-scan-types';

/** "scanned 9 files · 1.8 s" — the real count and the real time of the read. */
export function scannedLabel(files: number, ms: number): string {
  return `scanned ${files} file${files === 1 ? '' : 's'} · ${(ms / 1000).toFixed(1)} s`;
}

const n = (k: number, one: string, many = `${one}s`): string => `${k} ${k === 1 ? one : many}`;

/** "Adds 2 services · 3 resources · 1 job · 31 lines". */
export function draftSummary(graph: AppGraph | null, yaml: string): string {
  const lines = yaml.trimEnd().split('\n').length;
  if (!graph) return n(lines, 'line');
  return [
    `Adds ${n(graph.services.length, 'service')}`,
    graph.data.length ? n(graph.data.length, 'resource') : null,
    graph.jobs.length ? n(graph.jobs.length, 'job') : null,
    n(lines, 'line'),
  ]
    .filter(Boolean)
    .join(' · ');
}

const KIND: Record<DetectionKind, { word: string; tone: GitChipTone }> = {
  web: { word: 'service', tone: 'idle' },
  worker: { word: 'service', tone: 'idle' },
  postgres: { word: 'postgres 16', tone: 'info' },
  cache: { word: 'valkey', tone: 'warn' },
  queue: { word: 'queue', tone: 'warn' },
  bucket: { word: 'bucket', tone: 'ok' },
  cron: { word: 'cron', tone: 'mesh' },
};

export function kindChip(d: Detection): { word: string; tone: GitChipTone } {
  return d.kind === 'cron' && d.via === 'in-process' ? { word: 'schedule', tone: 'mesh' } : KIND[d.kind];
}

export function toggleId(selected: readonly string[], id: string): string[] {
  return selected.includes(id) ? selected.filter((s) => s !== id) : [...selected, id];
}

export interface YamlRow {
  no: number;
  indent: string;
  key: string;
  /** `:` or `: ` — empty for a comment or a list item. */
  sep: string;
  value: string;
  comment: string;
}

/** One row per line: indent · key · value · trailing comment (a light split, not a YAML parser). */
export function yamlRows(yaml: string): YamlRow[] {
  return yaml
    .replace(/\n$/, '')
    .split('\n')
    .map((line, i) => {
      const indent = /^\s*/.exec(line)![0];
      const rest = line.slice(indent.length);
      if (rest.startsWith('#') || !rest) return { no: i + 1, indent, key: '', sep: '', value: '', comment: rest };
      const m = /^([^:#]+?):(\s|$)(.*)$/.exec(rest);
      if (!m) return { no: i + 1, indent, key: '', sep: '', value: rest, comment: '' };
      const [value = '', comment = ''] = splitComment(m[3]!);
      return { no: i + 1, indent, key: m[1]!, sep: m[3] ? ': ' : ':', value, comment };
    });
}

function splitComment(v: string): [string, string] {
  const i = v.search(/\s#\s/);
  return i < 0 ? [v, ''] : [v.slice(0, i), v.slice(i + 1)];
}

/** `NODE_ENV=production` lines (or comma-separated) → `build.args`. */
export function parseArgs(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of text.split(/[\n,]/)) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(part);
    if (m) out[m[1]!] = m[2]!;
  }
  return out;
}

/** `services/orders, packages/shared` → `build.watch`. */
export function parseList(text: string): string[] {
  return text
    .split(/[\n,]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** The form's text fields → the `build:` keys the draft sends (blank = schema default). */
export function buildOptions(f: { path: string; dockerfile: string; target: string; args: string; watch: string }): BuildOptions {
  const args = parseArgs(f.args);
  const watch = parseList(f.watch);
  return {
    ...(f.path.trim() ? { path: f.path.trim() } : {}),
    ...(f.dockerfile.trim() ? { dockerfile: f.dockerfile.trim() } : {}),
    ...(f.target.trim() ? { target: f.target.trim() } : {}),
    ...(Object.keys(args).length ? { args } : {}),
    ...(watch.length ? { watch } : {}),
  };
}
