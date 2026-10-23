import type { Tone } from '@/components/calm';
import type { MapRegion } from './map-model';
import { regionsOf } from './map-model';

/**
 * "What this means" (board AppPlacement): the consequences of where the app
 * runs, in a few plain lines — how far the picked part is spread, which
 * single copies restart elsewhere (or wait for their data), and which
 * servers sit behind NAT. Only what the data shows. PURE — unit-tested in placement-model.test.ts.
 */

export interface Note {
  tone: Tone;
  text: string;
}

export interface SingleCopy {
  part: string;
  /** Where the one copy runs, when known. */
  server: string | null;
  /** Pinned with its data: it waits for that server instead of moving. */
  pinned: boolean;
}

const and = (xs: string[]): string => (xs.length < 2 ? (xs[0] ?? '') : `${xs.slice(0, -1).join(', ')} and ${xs.at(-1)}`);

export function meaningNotes({ part, declared, map, singles }: { part: string; declared: string[]; map: MapRegion[]; singles: SingleCopy[] }): Note[] {
  const notes: Note[] = [];
  const today = regionsOf(map, part);
  if (declared.length > 1) {
    notes.push({ tone: 'ok', text: `${part} runs in ${and(declared)}: if one region goes dark, the other${declared.length > 2 ? 's keep' : ' keeps'} ${part} up.` });
  } else if (declared.length === 1) {
    notes.push({ tone: 'warn', text: `${part} runs only in ${declared[0]}. Simple, but if ${declared[0]} goes dark, ${part} is down.` });
  } else if (today.length > 1) {
    notes.push({ tone: 'ok', text: `${part} isn’t tied to a region. Today its copies are in ${and(today)}, so one region going dark leaves the rest serving.` });
  } else if (today.length === 1) {
    notes.push({ tone: 'warn', text: `${part} isn’t tied to a region, but today every copy is in ${today[0]}: if it goes dark, so does ${part}.` });
  }
  for (const s of singles.slice(0, 3)) {
    const where = s.server ? `, on ${s.server}` : '';
    notes.push(
      s.pinned
        ? { tone: 'info', text: `${s.part} runs one copy${where}, kept with its data: if that server stops, ${s.part} waits for it.` }
        : { tone: 'info', text: `${s.part} runs one copy${where}: if that server stops, swarmy starts it on another.` },
    );
  }
  for (const r of map) {
    for (const s of r.servers) {
      if (s.nat && s.parts.length > 0) {
        notes.push({ tone: 'mesh', text: `${s.node.name} has no public address: it’s reached over the private network, so it never serves your address directly.` });
      }
    }
  }
  return notes;
}
