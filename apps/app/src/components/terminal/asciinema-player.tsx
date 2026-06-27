import * as React from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';

/**
 * Minimal asciicast v2 replay player built on the xterm.js we already ship — no
 * extra `asciinema-player` dependency. Parses the `.cast` text (header line +
 * `[time, "o"|"i", data]` events) and replays output events into a read-only
 * terminal on a wall-clock schedule, with play/pause/restart + a speed toggle.
 */

interface CastHeader {
  version: number;
  width: number;
  height: number;
  timestamp?: number;
}
type CastEvent = [number, 'o' | 'i', string];

function parseCast(text: string): { header: CastHeader; events: CastEvent[] } {
  const lines = text.split('\n').filter((l) => l.trim().length > 0);
  const header = JSON.parse(lines[0] ?? '{}') as CastHeader;
  const events: CastEvent[] = [];
  for (const line of lines.slice(1)) {
    try {
      const ev = JSON.parse(line) as CastEvent;
      if (Array.isArray(ev) && ev.length === 3 && ev[1] === 'o') events.push(ev);
    } catch {
      // skip malformed lines
    }
  }
  return { header, events };
}

interface AsciinemaPlayerProps {
  cast: string;
  className?: string;
}

const b64decode = (s: string): Uint8Array => {
  // Recordings store raw (binary) strings; decode as Latin-1 code units.
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff;
  return out;
};

export function AsciinemaPlayer({ cast, className }: AsciinemaPlayerProps): React.JSX.Element {
  const hostRef = React.useRef<HTMLDivElement | null>(null);
  const termRef = React.useRef<Terminal | null>(null);
  const timersRef = React.useRef<ReturnType<typeof setTimeout>[]>([]);
  const [playing, setPlaying] = React.useState(false);
  const [speed, setSpeed] = React.useState(1);

  const parsed = React.useMemo(() => parseCast(cast), [cast]);
  const duration = parsed.events.length ? parsed.events[parsed.events.length - 1]![0] : 0;

  React.useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const term = new Terminal({
      fontFamily: 'var(--font-mono, "Geist Mono", monospace)',
      fontSize: 13,
      theme: { background: '#0b1020' },
      disableStdin: true,
      scrollback: 10_000,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host);
    fit.fit();
    termRef.current = term;
    return () => {
      term.dispose();
      termRef.current = null;
    };
  }, []);

  const clearTimers = React.useCallback(() => {
    timersRef.current.forEach(clearTimeout);
    timersRef.current = [];
  }, []);

  const play = React.useCallback(() => {
    const term = termRef.current;
    if (!term) return;
    clearTimers();
    term.reset();
    setPlaying(true);
    for (const [t, , data] of parsed.events) {
      const handle = setTimeout(() => term.write(b64decode(data)), (t * 1000) / speed);
      timersRef.current.push(handle);
    }
    const end = setTimeout(() => setPlaying(false), (duration * 1000) / speed + 50);
    timersRef.current.push(end);
  }, [parsed.events, duration, speed, clearTimers]);

  const pause = React.useCallback(() => {
    clearTimers();
    setPlaying(false);
  }, [clearTimers]);

  React.useEffect(() => () => clearTimers(), [clearTimers]);

  return (
    <div className={className}>
      <div className="mb-2 flex items-center gap-2 text-sm">
        <button
          type="button"
          className="rounded-md border px-3 py-1"
          onClick={() => (playing ? pause() : play())}
        >
          {playing ? 'Pause' : 'Play'}
        </button>
        <button type="button" className="rounded-md border px-3 py-1" onClick={play}>
          Restart
        </button>
        <button
          type="button"
          className="rounded-md border px-3 py-1"
          onClick={() => setSpeed((s) => (s >= 4 ? 1 : s * 2))}
        >
          {speed}×
        </button>
        <span className="text-muted-foreground mono-data ml-auto text-xs">
          {duration.toFixed(1)}s · {parsed.events.length} frames
        </span>
      </div>
      <div
        ref={hostRef}
        style={{ width: '100%', height: '60vh', minHeight: 360, background: '#0b1020', padding: 8, borderRadius: 12 }}
      />
    </div>
  );
}
