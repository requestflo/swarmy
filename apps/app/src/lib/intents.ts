/**
 * ⌘K plain-language intents (the Command board): "undo analytics",
 * "add a domain to shop", "restart checkout", "scale api to 3". Pure: the
 * palette passes what it knows (apps, their parts, servers) and gets back
 * ranked intents, each mapped to a real action — a tRPC mutation the preview
 * pane runs after you confirm, or a page to open (with the form prefilled).
 */

export interface IntentApp {
  name: string;
  /** Every address the app answers on ("shop.northwind.dev"), so "shop" finds it. */
  hosts: string[];
}

export interface IntentPart {
  id: string;
  /** The part's own name ("checkout"), without the app prefix. */
  name: string;
  app: string | null;
  desired: number;
}

export interface IntentWorld {
  apps: IntentApp[];
  parts: IntentPart[];
}

export type IntentAction =
  | { kind: 'go'; to: string; params?: Record<string, string>; search?: Record<string, string> }
  | { kind: 'rollback'; app: string }
  | { kind: 'restart'; part: IntentPart }
  | { kind: 'scale'; part: IntentPart; to: number };

export interface Intent {
  id: string;
  /** The board's intent label: "Intent · Put back". */
  verb: string;
  group: 'Do it' | 'Jump to';
  title: string;
  sub: string;
  action: IntentAction;
}

export const INTENT_EXAMPLES = ['undo storefront', 'add a domain to shop', 'restart checkout', 'why is storefront slow'];

const norm = (s: string) => s.toLowerCase().replace(/[“”"']/g, '').replace(/\s+/g, ' ').trim();

/** An app by name, name prefix, or the first label of one of its addresses. */
export function findApp(world: IntentWorld, word: string): IntentApp | null {
  const w = norm(word);
  if (!w) return null;
  return (
    world.apps.find((a) => a.name.toLowerCase() === w) ??
    world.apps.find((a) => a.hosts.some((h) => h.toLowerCase() === w || h.toLowerCase().split('.')[0] === w)) ??
    world.apps.find((a) => a.name.toLowerCase().startsWith(w)) ??
    null
  );
}

export function findParts(world: IntentWorld, word: string): IntentPart[] {
  const w = norm(word);
  if (!w) return [];
  const exact = world.parts.filter((p) => p.name.toLowerCase() === w);
  return exact.length ? exact : world.parts.filter((p) => p.name.toLowerCase().startsWith(w));
}

const app$ = (a: string, tab?: string): IntentAction => ({
  kind: 'go',
  to: tab ? `/stacks/$name/${tab}` : '/stacks/$name',
  params: { name: a },
});

const DOMAIN = /^[a-z0-9-]+(\.[a-z0-9-]+)+$/;

export function parseIntents(query: string, world: IntentWorld): Intent[] {
  const q = norm(query);
  if (q.length < 3) return [];
  const out: Intent[] = [];
  const push = (i: Intent) => {
    if (!out.some((o) => o.id === i.id)) out.push(i);
  };
  let m: RegExpMatchArray | null;

  if ((m = q.match(/^(?:undo|roll ?back|revert|put back|go back)(?: on)? (\S+)/))) {
    const a = findApp(world, m[1]!);
    if (a) {
      push({ id: `rollback:${a.name}`, verb: 'Put back', group: 'Do it', title: `Put back ${a.name}'s last healthy version`, sub: 'one copy at a time · the current one stays in the history', action: { kind: 'rollback', app: a.name } });
      push({ id: `go:releases:${a.name}`, verb: 'Put back', group: 'Jump to', title: `${a.name} › Releases`, sub: 'every version and what changed', action: app$(a.name, 'releases') });
    }
  }

  if ((m = q.match(/^restart (\S+)/))) {
    const parts = findParts(world, m[1]!);
    const a = parts.length ? null : findApp(world, m[1]!);
    for (const p of parts.length ? parts : world.parts.filter((x) => a && x.app === a.name)) {
      push({ id: `restart:${p.id}`, verb: 'Restart', group: 'Do it', title: `Restart ${p.name}${p.app ? ` in ${p.app}` : ''}`, sub: 'one copy at a time, so nobody sees a gap', action: { kind: 'restart', part: p } });
    }
  }

  if ((m = q.match(/^(?:scale|run) (\S+) (?:to |at )?(\d{1,3})(?: cop(?:y|ies))?$/))) {
    const to = Number(m[2]);
    for (const p of findParts(world, m[1]!)) {
      if (p.desired === to) continue;
      push({ id: `scale:${p.id}:${to}`, verb: 'Copies', group: 'Do it', title: `Run ${to} ${to === 1 ? 'copy' : 'copies'} of ${p.name}`, sub: `${p.desired} now · ${to > p.desired ? 'adds' : 'removes'} them one at a time`, action: { kind: 'scale', part: p, to } });
    }
  }

  // "add a domain to shop", "add journal.shop.dev to shop", "give blog a domain"
  const d1 = q.match(/^(?:add|attach)(?: an?)?(?: new)? (?:domain|address)(?: (\S+\.\S+))? (?:to|for) (\S+)(?: (\S+\.\S+))?$/);
  const d2 = q.match(/^give (\S+) an?(?: new)? (?:domain|address)(?: (\S+\.\S+))?$/);
  const d3 = q.match(/^add (\S+\.\S+) to (\S+)$/);
  const dom = d1 ? { app: d1[2]!, host: d1[1] ?? d1[3] } : d2 ? { app: d2[1]!, host: d2[2] } : d3 ? { app: d3[2]!, host: d3[1] } : null;
  if (dom) {
    const a = findApp(world, dom.app);
    const h = dom.host && DOMAIN.test(dom.host) ? dom.host : undefined;
    if (a) {
      push({ id: `domain:${a.name}:${h ?? ''}`, verb: 'Add a domain', group: 'Do it', title: h ? `Add ${h} to ${a.name}` : `Add a domain to ${a.name}`, sub: 'opens the form on its Domains tab · HTTPS is automatic', action: { kind: 'go', to: '/stacks/$name/network', params: { name: a.name }, search: { add: h ?? '' } } });
    }
  }

  if ((m = q.match(/^(?:why is|what's wrong with|whats wrong with|logs? (?:for|of)?|debug) ?(\S+)/))) {
    const a = findApp(world, m[1]!);
    if (a) {
      push({ id: `go:obs:${a.name}`, verb: 'Question', group: 'Jump to', title: `${a.name} › Logs & traces`, sub: 'what swarmy is watching and why it looks the way it does', action: app$(a.name, 'observability') });
      push({ id: `go:errors:${a.name}`, verb: 'Question', group: 'Jump to', title: `${a.name} › Errors`, sub: 'open errors, newest first', action: app$(a.name, 'errors') });
    }
  }

  if ((m = q.match(/^(?:back ?up|backups?|restore)(?: of)? (\S+)/))) {
    const a = findApp(world, m[1]!);
    if (a) push({ id: `go:backups:${a.name}`, verb: 'Restore', group: 'Jump to', title: `${a.name} › Backups`, sub: 'restore points and where they are kept', action: app$(a.name, 'backups') });
  }

  if (/^(?:add|new|connect)(?: an?)? (?:server|node|machine)/.test(q)) {
    push({ id: 'go:add-server', verb: 'Add a server', group: 'Do it', title: 'Add a server', sub: 'one line to run on it', action: { kind: 'go', to: '/nodes/new' } });
  }

  return out;
}
