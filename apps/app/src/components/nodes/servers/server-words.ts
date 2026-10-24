import type { NodeSummary } from '@swarmy/core';
import type { Tone } from '@/components/calm';
import { numberWord } from '@/components/apps/app-words';

/**
 * The agent's version skew in plain words, or null when it's in step (or
 * unknown). `upgrade` = the Upgrade agent button applies; an incompatible
 * agent can't take a command, so it is pointed at the install line instead.
 */
export function agentSkewWords(
  n: Pick<NodeSummary, 'agentSkew'>,
): { say: string; word: string; tone: Tone; upgrade: boolean } | null {
  const s = n.agentSkew;
  if (!s || s.status === 'ok') return null;
  if (s.status === 'incompatible') {
    const say = 'This server’s agent can’t talk to swarmy. Re-run the install line on it to reinstall the agent.';
    return { say, word: 'Agent mismatch', tone: 'bad', upgrade: false };
  }
  if (s.status === 'ahead') {
    return { say: 'This server’s agent is newer than swarmy. Upgrade swarmy to match.', word: 'Agent ahead', tone: 'info', upgrade: false };
  }
  const by = s.versions ? `${numberWord(s.versions, true)} ${s.versions === 1 ? 'version' : 'versions'} behind` : 'behind';
  return { say: `This server’s agent is ${by}`, word: 'Agent behind', tone: 'warn', upgrade: true };
}

/** Status → the calm tone + the five-word vocabulary. */
export function serverTone(n: Pick<NodeSummary, 'status'>): { tone: Tone; word: string } {
  switch (n.status) {
    case 'online':
      return { tone: 'ok', word: 'Online' };
    case 'draining':
      return { tone: 'warn', word: 'Emptying' };
    case 'degraded':
      return { tone: 'warn', word: 'Needs you' };
    case 'offline':
      return { tone: 'bad', word: 'Offline' };
    default:
      return { tone: 'idle', word: 'Joining' };
  }
}

/** What a server does, in plain words (Summary). */
export function plainRoles(n: NodeSummary): string[] {
  const out: string[] = [];
  if (n.role === 'manager') out.push('Runs swarmy');
  if (n.ingress) out.push('Front door');
  if (n.database) out.push('Databases');
  if (n.storage) out.push('File storage');
  if (n.builder) out.push('Builds apps');
  if (n.outlet) out.push('Outbound traffic');
  if (out.length === 0) out.push('Runs apps');
  return out;
}

/** The same roles as swarmy sees them (Controls). */
export function techRoles(n: NodeSummary): string {
  const flags = ['ingress', 'outlet', 'storage', 'database', 'builder'] as const;
  return [n.role, ...flags.filter((f) => n[f])].join(' · ');
}

/** "12 GB" style, whole numbers from 10 GB up. */
export function gb(bytes: number | null | undefined): string {
  if (bytes == null) return '—';
  const v = bytes / 1024 ** 3;
  return `${v >= 10 ? v.toFixed(0) : v.toFixed(1)} GB`;
}
