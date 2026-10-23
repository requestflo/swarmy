import type { BucketDetailView, BucketPermissionsView } from '@swarmy/core';
import { shortName } from './attach-plan';

/** "read-write" · "read" · "write-only" (+ " · owner"). */
export function permWord(p: BucketPermissionsView | undefined): string {
  if (!p) return 'no access';
  const base = p.read && p.write ? 'read-write' : p.read ? 'read' : p.write ? 'write-only' : p.owner ? '' : 'no access';
  return p.owner ? (base ? `${base} · owner` : 'owner') : base;
}

export interface AttachedRow {
  app: string;
  service: string;
  /** The full service name (what detach takes). */
  serviceName: string;
  perm: string;
  accessKeyId: string;
}

/** Each attachment with what its key may do on this bucket. */
export function attachedRows(b: Pick<BucketDetailView, 'attachments' | 'keys'>): AttachedRow[] {
  return b.attachments.map((a) => ({
    app: a.stack,
    service: shortName(a.stack, a.service),
    serviceName: a.service,
    perm: permWord(b.keys.find((k) => k.accessKeyId === a.accessKeyId)?.permissions),
    accessKeyId: a.accessKeyId,
  }));
}

/** "Can't delete: holds 212,904 objects · attached to storefront", or null when it can go. */
export function deleteBlocked(b: Pick<BucketDetailView, 'objects' | 'attachments'>): string | null {
  const parts: string[] = [];
  if (b.objects > 0) parts.push(`holds ${b.objects.toLocaleString('en-US')} object${b.objects === 1 ? '' : 's'}`);
  const apps = [...new Set(b.attachments.map((a) => a.stack))];
  if (apps.length) parts.push(`attached to ${apps.join(', ')}`);
  return parts.length ? `Can’t delete: ${parts.join(' · ')}` : null;
}

export interface CopyMember {
  name: string;
  online: boolean;
  draining?: boolean | null;
  up?: boolean | null;
}

/** The plain line under the copies: what survives a lost server. */
export function copiesSay(copies: number, members: readonly CopyMember[]): string {
  const live = members.filter((m) => m.online && m.up !== false).length;
  if (copies <= 1) return 'One copy of each file. If its server is lost, so are the files.';
  if (live < members.length) {
    const down = members.length - live;
    const one = down === 1;
    return `${down} of ${members.length} servers ${one ? 'is' : 'are'} not answering, so some files have fewer copies until ${one ? 'it is' : 'they are'} back.`;
  }
  const of = members.length > copies ? ` of these ${members.length}` : '';
  return `Each file is kept on ${copies}${of} servers. Any one can be lost and every file is still served.`;
}

/** A member's status word. */
export function memberWord(m: CopyMember): { word: string; tone: 'ok' | 'warn' | 'bad' } {
  if (!m.online || m.up === false) return { word: 'not answering', tone: 'bad' };
  if (m.draining) return { word: 'emptying', tone: 'warn' };
  return { word: 'online', tone: 'ok' };
}

/** Share of the quota used (0–100), or null when there is no size limit. */
export function quotaPct(usageBytes: number, maxSizeBytes: number | null): number | null {
  if (!maxSizeBytes) return null;
  return Math.min(100, Math.round((usageBytes / maxSizeBytes) * 1000) / 10);
}
