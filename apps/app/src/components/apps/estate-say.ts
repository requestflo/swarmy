import type { Tone } from '@/components/calm';
import { numberWord, plural, type AppWords } from './app-words';

/** A sentence headline as parts: a calm lead and the clause that matters (in its tone). */
export interface SayParts {
  lead: string;
  clause: { tone: Tone; text: string } | null;
}

export interface EstateFacts {
  /** User apps (the system stack excluded), each with its words. */
  apps: { name: string; words: AppWords }[];
  alertsFiring: number;
  incidentsOpen: number;
  nodesOnline: number;
  nodesTotal: number;
}

function joinNames(names: string[]): string {
  if (names.length === 1) return names[0]!;
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${numberWord(names.length)} apps`;
}

/** "Three apps are calm." + the one clause that matters, from real app/alert/server state. */
export function estateSay(f: EstateFacts): SayParts {
  const attention = f.apps.filter((a) => a.words.attention);
  const deploying = f.apps.filter((a) => a.words.tone === 'info');
  const calm = f.apps.length - attention.length - deploying.length;

  const calmLead = (count: number): string =>
    count === 0
      ? ''
      : f.apps.length === 1
        ? `${f.apps[0]!.name} is calm.`
        : `${numberWord(count)} app${count === 1 ? ' is' : 's are'} calm.`;

  if (attention.length > 0) {
    const down = attention.filter((a) => a.words.tone === 'bad');
    const names = attention.map((a) => a.name);
    const text =
      attention.length === 1
        ? `${names[0]} ${down.length ? 'is down.' : 'needs you.'}`
        : `${joinNames(names)} need you.`;
    return { lead: calmLead(calm), clause: { tone: down.length ? 'bad' : 'warn', text } };
  }
  const lead = calmLead(calm);
  if (f.incidentsOpen > 0) {
    return { lead, clause: { tone: 'bad', text: f.incidentsOpen === 1 ? 'An incident is open.' : `${numberWord(f.incidentsOpen)} incidents are open.` } };
  }
  if (f.alertsFiring > 0) {
    return {
      lead,
      clause: { tone: 'warn', text: f.alertsFiring === 1 ? 'One alert is firing.' : `${numberWord(f.alertsFiring)} alerts are firing.` },
    };
  }
  const offline = f.nodesTotal - f.nodesOnline;
  if (offline > 0) {
    return { lead, clause: { tone: 'warn', text: `${offline === 1 ? 'A server is' : `${numberWord(offline)} servers are`} offline.` } };
  }
  if (deploying.length > 0) {
    return { lead, clause: { tone: 'info', text: `${joinNames(deploying.map((a) => a.name))} ${deploying.length === 1 ? 'is' : 'are'} deploying.` } };
  }
  return { lead: lead || 'All calm.', clause: null };
}

/** The Apps page lead: "4 apps." then the same clause. */
export function appsSay(f: EstateFacts): SayParts {
  const parts = estateSay(f);
  const lead = `${plural(f.apps.length, 'app')}.`;
  const attention = f.apps.some((a) => a.words.attention || a.words.tone === 'info');
  return { lead: attention ? lead : `${lead} All calm.`, clause: attention ? parts.clause : null };
}
