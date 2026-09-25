import type { NodeSummary } from '@swarmy/core';
import type { Tone } from '@/components/calm';

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
