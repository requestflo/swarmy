import * as React from 'react';
import { diffEnv, parseDotenv, type DotenvParseOptions, type EnvDiff, type DotenvWarning } from '@swarmy/core';

export interface EnvPasteState {
  text: string;
  setText: (t: string) => void;
  mode: 'merge' | 'replace';
  setMode: (m: 'merge' | 'replace') => void;
  diff: EnvDiff;
  warnings: DotenvWarning[];
  /** Keys shown masked; seeded from `looksSecret`, flippable per row. */
  masked: Set<string>;
  toggleMask: (key: string) => void;
  changed: boolean;
}

/** Paste → parse → diff against `current`, with per-row mask overrides. */
export function useEnvPaste(current: Record<string, string>, opts?: DotenvParseOptions): EnvPasteState {
  const [text, setText] = React.useState('');
  const [mode, setMode] = React.useState<'merge' | 'replace'>('merge');
  const [overrides, setOverrides] = React.useState<Record<string, boolean>>({});
  const parsed = React.useMemo(() => parseDotenv(text, opts), [text, opts]);
  const diff = React.useMemo(() => diffEnv(current, parsed.entries, mode), [current, parsed, mode]);

  const masked = React.useMemo(() => {
    const s = new Set<string>();
    for (const r of diff.rows) if (overrides[r.key] ?? r.secret) s.add(r.key);
    return s;
  }, [diff, overrides]);

  const toggleMask = React.useCallback(
    (key: string) => setOverrides((o) => ({ ...o, [key]: !masked.has(key) })),
    [masked],
  );

  const changed = diff.counts.added + diff.counts.changed + diff.counts.removed > 0;
  return { text, setText, mode, setMode, diff, warnings: parsed.warnings, masked, toggleMask, changed };
}
