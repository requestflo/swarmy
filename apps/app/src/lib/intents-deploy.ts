import type { Intent, IntentWorld } from './intents-types';

/**
 * "deploy ghost", "deploy ghost as blog", "deploy ghost to london",
 * "deploy n8n as flows on mgr-1". The template matches by id or name (exact,
 * then prefix); the name defaults to the template id. `to <server>` is parsed
 * but not pinned yet: swarmy picks the server (the preview says so).
 */
const DEPLOY = /^(?:deploy|install|launch) (\S+)((?: (?:as|called|named) \S+| (?:to|on|onto) \S+)*)$/;

/** Lowercase letters, digits and dashes, up to 30 — the app-name rule. */
export function slugName(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/^-+/, '').slice(0, 30).replace(/-+$/, '');
}

export function deployIntents(q: string, world: IntentWorld): Intent[] {
  const m = q.match(DEPLOY);
  if (!m) return [];
  const word = m[1]!;
  const rest = m[2] ?? '';
  const t =
    world.templates.find((x) => x.id.toLowerCase() === word || x.name.toLowerCase() === word) ??
    world.templates.find((x) => x.id.toLowerCase().startsWith(word) || x.name.toLowerCase().startsWith(word)) ??
    null;
  if (!t) return [];
  const as = rest.match(/ (?:as|called|named) (\S+)/)?.[1];
  const to = rest.match(/ (?:to|on|onto) (\S+)/)?.[1] ?? null;
  const name = slugName(as ?? t.id) || 'app';
  const server = to ? (world.servers.find((s) => s.toLowerCase() === to || s.toLowerCase().startsWith(to)) ?? null) : null;
  const edit = { kind: 'go' as const, to: '/deploy/$template', params: { template: t.id }, search: { name } };
  return [
    {
      id: `deploy:${t.id}:${name}`,
      verb: 'Deploy',
      group: 'Do it',
      title: `Deploy ${t.name} as ${name}`,
      sub: 'gets a web address with HTTPS · backups and alerts on',
      action: { kind: 'deploy', template: t.id, name, to, server },
      edit,
    },
    {
      id: `go:deploy:${t.id}:${name}`,
      verb: 'Deploy',
      group: 'Jump to',
      title: `Configure ${t.name}`,
      sub: 'name, address, secrets and size before it goes out',
      action: edit,
    },
  ];
}
