import { describe, expect, it } from 'bun:test';
import {
  buildAsciicast,
  parseAsciicast,
  ASCIICAST_VERSION,
  type AsciicastEvent,
  type AsciicastHeader,
} from './terminal-recording';

const header: AsciicastHeader = {
  version: ASCIICAST_VERSION,
  width: 80,
  height: 24,
  timestamp: 1_700_000_000,
};

describe('asciicast build/parse (recording chunk assembly)', () => {
  it('round-trips a header + ordered output events', () => {
    const events: AsciicastEvent[] = [
      [0.0, 'o', 'hello '],
      [0.5, 'o', 'world\r\n'],
      [1.25, 'o', '$ '],
    ];
    const text = buildAsciicast(header, events);

    // Header is the first line; one JSON line per event.
    const lines = text.trim().split('\n');
    expect(lines.length).toBe(4);
    expect(JSON.parse(lines[0]!).version).toBe(ASCIICAST_VERSION);

    const parsed = parseAsciicast(text);
    expect(parsed.header.width).toBe(80);
    expect(parsed.events).toEqual(events);
  });

  it('reassembles the full output stream in order', () => {
    const chunks = ['ab', 'cd', 'ef'];
    const events: AsciicastEvent[] = chunks.map((c, i) => [i * 0.1, 'o', c]);
    const parsed = parseAsciicast(buildAsciicast(header, events));
    const reassembled = parsed.events
      .filter((e) => e[1] === 'o')
      .map((e) => e[2])
      .join('');
    expect(reassembled).toBe('abcdef');
  });

  it('tolerates blank/trailing lines', () => {
    const text = buildAsciicast(header, [[0, 'o', 'x']]) + '\n\n';
    const parsed = parseAsciicast(text);
    expect(parsed.events.length).toBe(1);
  });

  it('rejects an unsupported version', () => {
    const bad = JSON.stringify({ ...header, version: 1 }) + '\n';
    expect(() => parseAsciicast(bad)).toThrow();
  });

  it('rejects an empty cast', () => {
    expect(() => parseAsciicast('')).toThrow();
  });
});
