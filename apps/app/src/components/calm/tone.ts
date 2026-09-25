/** The five status tones, as text-safe colour classes (4.5:1 in both themes). */
export type Tone = 'ok' | 'warn' | 'bad' | 'info' | 'mesh' | 'idle';

export const TONE_TEXT: Record<Tone, string> = {
  ok: 'text-tone-ok',
  warn: 'text-tone-warn',
  bad: 'text-tone-bad',
  info: 'text-tone-info',
  mesh: 'text-tone-mesh',
  idle: 'text-tone-idle',
};

/** Dot fills (decorative; the word beside a dot carries the meaning). */
export const TONE_DOT: Record<Tone, string> = {
  ok: 'bg-status-online',
  warn: 'bg-status-warning',
  bad: 'bg-status-offline',
  info: 'bg-status-progress',
  mesh: 'bg-tone-mesh',
  idle: 'bg-status-idle',
};

/** Map the older `StatusBadge` tones onto Calm tones. */
export function toneFromStatus(s: 'online' | 'warning' | 'offline' | 'neutral' | 'progress'): Tone {
  return s === 'online' ? 'ok' : s === 'warning' ? 'warn' : s === 'offline' ? 'bad' : s === 'progress' ? 'info' : 'idle';
}
