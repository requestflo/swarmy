import { redisCliPrefix } from './queues.service';

/**
 * Connected BullMQ workers — PURE (queue-workers.test.ts). The same count
 * BullMQ's `Queue.getWorkers()` gives: every Worker opens one blocking
 * connection named `<prefix>:<base64 queue name>` (plus `:w:<name>` when the
 * worker is given a name), so the cache's CLIENT LIST says how many are
 * connected. QueueEvents (`…:qe`) and other clients don't match.
 *
 * CLIENT is `noscript`, so this is a plain CLI call, not an EVAL. The shell
 * keeps only the ` name=` fields, so client addresses and commands never
 * leave the container; a reply that isn't a client list (auth error, no
 * grep) fails the exec rather than reading as zero workers.
 */

/** The connection name BullMQ gives a queue's workers. */
export function bullClientName(prefix: string, queue: string): string {
  return `${prefix}:${Buffer.from(queue, 'utf8').toString('base64')}`;
}

/** Shell script printing one ` name=<client name>` line per connected client. */
export function clientNamesCommand(engine: 'valkey' | 'redis'): string {
  return [
    'command -v grep >/dev/null 2>&1 || exit 3',
    `out=$(${redisCliPrefix(engine)} CLIENT LIST) || exit 1`,
    `case "$out" in id=*) ;; *) printf '%s\\n' "$out" | head -c 300 >&2; exit 2 ;; esac`,
    `printf '%s\\n' "$out" | grep -o ' name=[^ ]*' || true`,
  ].join('\n');
}

/** Count a queue's workers in the script's output; names = the `:w:` suffixes, unique. */
export function bullWorkersOf(raw: string, prefix: string, queue: string): { connected: number; names: string[] } {
  const base = bullClientName(prefix, queue);
  let connected = 0;
  const names = new Set<string>();
  for (const line of raw.split(/\r?\n/)) {
    const m = /^\s*name=(\S*)$/.exec(line);
    if (!m) continue;
    const name = m[1] ?? '';
    if (name === base) connected++;
    else if (name.startsWith(`${base}:w:`)) {
      connected++;
      const n = name.slice(base.length + 3);
      if (n) names.add(n);
    }
  }
  return { connected, names: [...names].sort() };
}
