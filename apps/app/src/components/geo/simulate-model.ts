import type { Tone } from '@/components/calm';
import type { AskEndpoint } from './ask-model';

/** `geodns.simulateDown`'s answer (dns-simulate.service.ts). */
export interface DownSimulation {
  host: string;
  ttl: number;
  down: { ip: string; region: string; healthy: boolean };
  regions: Array<{ from: string; before: string[]; after: string[]; degraded: boolean; steered: boolean }>;
}

export interface SimLine {
  from: string;
  label: string;
  tone: Tone;
  word: string;
  say: string;
  tech: string;
}

/** How often the controller re-checks front doors and re-pushes answers (dns-reconcile tick). */
export const DNS_TICK_S = 15;

/** A region label's continent (`eu-west` → `eu`), the prefix the engine itself falls back to. */
function continent(region: string | undefined): string {
  return (region ?? '').split('-')[0] ?? '';
}

function list(names: string[]): string {
  return names.length <= 1 ? (names[0] ?? 'nothing') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
}

/**
 * "What if <edge> went down?" in plain words, one line per visitor region:
 * who would answer, and whether visitors spill to another region. Never
 * names an edge the engine did not answer with.
 */
export function simulateWords(
  sim: DownSimulation,
  endpoints: AskEndpoint[],
  places: ReadonlyArray<{ id: string; label: string }>,
): { headline: string; lines: SimLine[]; timing: string } {
  const byIp = new Map(endpoints.map((e) => [e.ip, e] as const));
  const name = (ip: string): string => byIp.get(ip)?.name ?? ip;
  const downName = name(sim.down.ip);
  const lines = sim.regions.map((r): SimLine => {
    const label = places.find((p) => p.id === r.from)?.label ?? r.from;
    const tech = `${sim.host} A from “${r.from}”: ${r.before.join(', ') || 'none'} → ${r.after.join(', ') || 'none'}${r.degraded ? ' · degraded' : ''}`;
    const base = { from: r.from, label, tech };
    const after = r.after.map(name);
    if (r.after.length === 0) return { ...base, tone: 'bad', word: 'no answer', say: `${label} would get no answer: swarmy has no address for this name.` };
    if (r.degraded) return { ...base, tone: 'bad', word: 'everyone', say: `${label} would get every front door: none is left healthy, so swarmy answers with all of them rather than none.` };
    if (r.before[0] === sim.down.ip) {
      // Spilling = the nearest answer leaves the down edge's part of the world.
      const spill = continent(byIp.get(r.after[0]!)?.region) !== continent(sim.down.region);
      return spill
        ? { ...base, tone: 'warn', word: 'spills', say: `${label} would spill to ${list(after)}.` }
        : { ...base, tone: 'info', word: 'moves', say: `${label} would be answered by ${list(after)}.` };
    }
    if (r.before.includes(sim.down.ip)) {
      const rest = after.slice(1);
      const say = rest.length ? `${label} keeps ${after[0]}; ${list(rest)} becomes its fallback.` : `${label} keeps ${after[0]}, with no fallback left.`;
      return { ...base, tone: 'ok', word: 'keeps', say };
    }
    return { ...base, tone: 'ok', word: 'unchanged', say: `${label} keeps ${list(after)}.` };
  });
  const moved = lines.filter((l) => l.word === 'spills' || l.word === 'moves').length;
  const headline = !sim.down.healthy
    ? `${downName} is already out of the answers, so this is what visitors get now.`
    : lines.some((l) => l.word === 'everyone')
      ? `If ${downName} went down, no front door would be left healthy, so swarmy would answer with all of them.`
      : moved === 0
        ? `If ${downName} went down, every region would keep its front door: ${downName} is only ever a fallback.`
        : `If ${downName} went down, ${moved} of ${lines.length} regions would move to another front door.`;
  const timing = `Visitors already holding ${downName}’s address move within about ${DNS_TICK_S + sim.ttl} seconds: swarmy notices in ${DNS_TICK_S}, then their ${sim.ttl}-second answer runs out.`;
  return { headline, lines, timing };
}
