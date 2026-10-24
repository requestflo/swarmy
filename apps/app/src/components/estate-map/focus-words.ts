import type { ServiceSummary } from '@swarmy/core';
import { serverTone } from '@/components/nodes/servers/server-words';
import type { ServerView } from './estate-model';

/** What the server does, as verb phrases (the plain words `plainRoles` uses, made into a sentence). */
function rolePhrases(n: ServerView['node']): string[] {
  const out: string[] = [];
  if (n.role === 'manager') out.push('runs swarmy');
  if (n.ingress) out.push('is a front door for visitors');
  if (n.database) out.push('holds databases');
  if (n.storage) out.push('holds files');
  if (n.builder) out.push('builds your apps');
  if (n.outlet) out.push('sends outbound traffic');
  return out.length ? out : ['runs apps'];
}

const list = (xs: string[]): string => (xs.length <= 1 ? (xs[0] ?? '') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`);

/**
 * The focus panel's story (board 22) from what swarmy knows about one
 * server: what it does, which of your apps it runs, how busy it is and how
 * it is reached. No number that isn't measured.
 */
export function serverStory(s: ServerView): string {
  const out = [`It ${list(rolePhrases(s.node))}.`];
  out.push(s.apps.length ? `Runs ${list(s.apps.map((a) => a.app))}.` : 'Nothing of yours runs here.');
  if (s.busy) {
    const room = s.busy.pct >= 85 ? 'close to full' : s.busy.pct < 60 ? 'plenty of headroom' : 'some headroom';
    out.push(`${s.busy.which === 'CPU' ? 'CPU' : 'Memory'} is ${s.busy.pct}% busy, ${room}.`);
  } else {
    out.push('No live numbers right now.');
  }
  if (s.note === 'private network only') out.push('It has no public address, so it is reached over the private network.');
  else if (s.note) out.push('It has no public address.');
  const st = serverTone(s.node);
  if (st.tone !== 'ok') out.push(`Status: ${st.word.toLowerCase()}.`);
  return out.join(' ');
}

/** Your services on this server (swarmy's own parts can't be moved from here), for "Move…". */
export function movableServices(services: ServiceSummary[], apps: ReadonlySet<string>, stackOf: ReadonlyMap<string, string>): ServiceSummary[] {
  return services.filter((s) => {
    const stack = stackOf.get(s.id) ?? s.stackId;
    return stack ? apps.has(stack) : false;
  });
}
