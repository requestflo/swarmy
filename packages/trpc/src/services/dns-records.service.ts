import { DnsRecordType } from '@swarmy/core/protocol';
import type { OrgContext } from '../context';
import { notFound } from '../errors';
import { writeAudit } from './audit.service';
import { dnsZoneRepo } from './geodns.repo';

/**
 * Manual static records — the non-web zone content swarmy must answer once it
 * is THE nameserver (MX, TXT/SPF/DKIM, CNAME, SRV, CAA, child NS). Web A
 * records deliberately have no CRUD: they derive from ingress (invariant #5).
 */

export interface DnsRecordView {
  id: string;
  zoneId: string;
  /** Zone-relative name, '@' = apex. */
  name: string;
  type: string;
  value: string;
  ttl: number | null;
  priority: number | null;
}

const NAME_RE = /^(@|\*|(\*\.)?[a-z0-9_]([a-z0-9_.-]{0,61}[a-z0-9_])?)$/i;

export async function listRecords(ctx: OrgContext, zoneId: string): Promise<DnsRecordView[]> {
  const zone = await dnsZoneRepo.find(ctx, ctx.activeOrgId, zoneId);
  if (!zone) throw notFound('dnsZone', zoneId);
  const rows = await dnsZoneRepo.listRecords(ctx, ctx.activeOrgId, zoneId);
  return rows.map((r) => ({
    id: r.id,
    zoneId: r.zoneId,
    name: r.name,
    type: r.type,
    value: r.value,
    ttl: r.ttl,
    priority: r.priority,
  }));
}

export async function upsertRecord(
  ctx: OrgContext,
  input: {
    zoneId: string;
    name: string;
    type: string;
    value: string;
    ttl?: number;
    priority?: number;
  },
): Promise<DnsRecordView> {
  const zone = await dnsZoneRepo.find(ctx, ctx.activeOrgId, input.zoneId);
  if (!zone) throw notFound('dnsZone', input.zoneId);

  const type = DnsRecordType.parse(input.type.toUpperCase());
  const name = input.name.trim().toLowerCase() || '@';
  if (!NAME_RE.test(name)) throw new Error(`invalid record name: ${input.name}`);
  const value = input.value.trim();
  if (!value) throw new Error('record value is required');
  if ((type === 'MX' || type === 'SRV') && input.priority === undefined) {
    throw new Error(`${type} records need a priority`);
  }

  const row = await dnsZoneRepo.upsertRecord(ctx, ctx.activeOrgId, input.zoneId, {
    name,
    type,
    value,
    ttl: input.ttl ?? null,
    priority: input.priority ?? null,
  });
  if (!row) throw notFound('dnsZone', input.zoneId);
  await writeAudit(ctx, {
    action: 'dns.record.upsert',
    targetType: 'dnsRecord',
    targetId: row.id,
    metadata: { zone: zone.zone, name, type, value },
  });
  return {
    id: row.id,
    zoneId: row.zoneId,
    name: row.name,
    type: row.type,
    value: row.value,
    ttl: row.ttl,
    priority: row.priority,
  };
}

export async function removeRecord(
  ctx: OrgContext,
  id: string,
): Promise<{ id: string; removed: true }> {
  const row = await dnsZoneRepo.findRecord(ctx, ctx.activeOrgId, id);
  if (!row) throw notFound('dnsRecord', id);
  await dnsZoneRepo.removeRecord(ctx, ctx.activeOrgId, id);
  await writeAudit(ctx, {
    action: 'dns.record.remove',
    targetType: 'dnsRecord',
    targetId: id,
    metadata: { name: row.name, type: row.type },
  });
  return { id, removed: true };
}
