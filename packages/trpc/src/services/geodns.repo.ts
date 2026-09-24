/**
 * Geo-DNS repositories — swarm-kv (P4 slice 1).
 *
 *  - `geodns/<orgId>`: GeoDnsConfig (enabled + geoip source REFERENCES).
 *  - `dns-zone/<zoneId>`: one document per zone holding the zone AND its
 *    manual records (MX/TXT/…) — they are only ever read together.
 *
 * The SOA serial and the composed-content signature that drives it are run
 * state, so they live in memory ({@link zoneSerial} / {@link bumpZoneSerial}).
 * A bump uses max(serial + 1, unix seconds), so serials keep increasing across
 * controller restarts without ever being stored.
 */
import { TRPCError } from '@trpc/server';
import { newKvId } from './swarm-kv.service';
import { orgCollection, orgSingleton, type KvRow, type KvScope } from './kv-repo';

// ── GeoDnsConfig ──────────────────────────────────────────────────────────────

export interface GeoDnsConfigDoc {
  enabled: boolean;
  /** geoipSource / maxmindLicenseSecretRef / mmdbConfigRef — references only. */
  settings: Record<string, unknown> | null;
}
export type GeoDnsConfigRow = KvRow<GeoDnsConfigDoc>;

export const geoDnsConfigRepo = orgSingleton<GeoDnsConfigDoc>('geodns', () => ({
  enabled: false,
  settings: null,
}));

// ── DnsZone + DnsRecord ───────────────────────────────────────────────────────

export interface DnsRecordDoc {
  id: string;
  /** Zone-relative name; '@' = apex. */
  name: string;
  type: string;
  value: string;
  ttl: number | null;
  priority: number | null;
}

interface DnsZoneDoc {
  zone: string;
  mode: string;
  enabled: boolean;
  ttl: number;
  apexToEdge: boolean;
  autoWww: boolean;
  advertisedNodeIds: string[];
  settings: Record<string, unknown> | null;
  records: DnsRecordDoc[];
}

/** A zone row as services see it: the stored zone + the in-memory serial. */
export type DnsZoneRow = Omit<KvRow<DnsZoneDoc>, 'records'> & { serial: number };
export type DnsRecordRow = DnsRecordDoc & { orgId: string; zoneId: string };

const zones = orgCollection<DnsZoneDoc>('dns-zone', () => ({
  mode: 'swarmy-ns',
  enabled: false,
  ttl: 30,
  apexToEdge: true,
  autoWww: true,
  advertisedNodeIds: [],
  settings: null,
  records: [],
}));

/** zoneId → { serial, content signature } — run state, never in raft. */
const serials = new Map<string, { serial: number; sig?: string }>();

export function zoneSerial(zoneId: string): number {
  return serials.get(zoneId)?.serial ?? 1;
}

/** The last content signature the serial was bumped for (undefined after a restart). */
export function zoneContentSig(zoneId: string): string | undefined {
  return serials.get(zoneId)?.sig;
}

/** Content changed: bump the serial (monotonic across restarts) and remember the signature. */
export function bumpZoneSerial(zoneId: string, sig: string): number {
  const serial = Math.max(zoneSerial(zoneId) + 1, Math.floor(Date.now() / 1000));
  serials.set(zoneId, { serial, sig });
  return serial;
}

function zoneRow(row: KvRow<DnsZoneDoc>): DnsZoneRow {
  const { records: _records, ...rest } = row;
  return { ...rest, advertisedNodeIds: rest.advertisedNodeIds ?? [], serial: zoneSerial(row.id) };
}

const byZone = (a: { zone: string }, b: { zone: string }) => (a.zone < b.zone ? -1 : a.zone > b.zone ? 1 : 0);

export interface ZoneFilter {
  enabled?: boolean;
  mode?: string | readonly string[];
}

function matches(row: KvRow<DnsZoneDoc>, f?: ZoneFilter): boolean {
  if (!f) return true;
  if (f.enabled !== undefined && row.enabled !== f.enabled) return false;
  if (f.mode !== undefined) {
    const modes = typeof f.mode === 'string' ? [f.mode] : f.mode;
    if (!modes.includes(row.mode)) return false;
  }
  return true;
}

export type DnsZonePatch = Partial<
  Pick<DnsZoneDoc, 'mode' | 'enabled' | 'ttl' | 'apexToEdge' | 'autoWww' | 'advertisedNodeIds' | 'settings'>
>;

export const dnsZoneRepo = {
  /** The org's zones, ordered by name. */
  async list(scope: KvScope, orgId: string, filter?: ZoneFilter): Promise<DnsZoneRow[]> {
    return (await zones.list(scope, orgId, (r) => matches(r, filter))).map(zoneRow).sort(byZone);
  },

  async find(scope: KvScope, orgId: string, id: string): Promise<DnsZoneRow | null> {
    const row = await zones.find(scope, orgId, id);
    return row ? zoneRow(row) : null;
  },

  /** Create a zone; a zone name is unique per org. */
  async create(scope: KvScope, orgId: string, input: { zone: string; mode: string }): Promise<DnsZoneRow> {
    if (await zones.findFirst(scope, orgId, (r) => r.zone === input.zone)) {
      throw new TRPCError({ code: 'CONFLICT', message: `zone ${input.zone} already exists` });
    }
    return zoneRow(
      await zones.create(scope, orgId, {
        zone: input.zone,
        mode: input.mode,
        enabled: false,
        ttl: 30,
        apexToEdge: true,
        autoWww: true,
        advertisedNodeIds: [],
        settings: null,
        records: [],
      }),
    );
  },

  async update(scope: KvScope, orgId: string, id: string, patch: DnsZonePatch): Promise<DnsZoneRow | null> {
    const row = await zones.update(scope, orgId, id, patch);
    return row ? zoneRow(row) : null;
  },

  async remove(scope: KvScope, orgId: string, id: string): Promise<boolean> {
    serials.delete(id);
    return zones.remove(scope, orgId, id);
  },

  // ── records (inside the zone document) ─────────────────────────────────────

  /** A zone's manual records, ordered by name then type. */
  async listRecords(scope: KvScope, orgId: string, zoneId: string): Promise<DnsRecordRow[]> {
    const row = await zones.find(scope, orgId, zoneId);
    return (row?.records ?? [])
      .map((r) => ({ ...r, orgId, zoneId }))
      .sort((a, b) => (a.name === b.name ? (a.type < b.type ? -1 : 1) : a.name < b.name ? -1 : 1));
  },

  /** Insert or update a record keyed by (name, type, value). */
  async upsertRecord(
    scope: KvScope,
    orgId: string,
    zoneId: string,
    input: Omit<DnsRecordDoc, 'id'>,
  ): Promise<DnsRecordRow | null> {
    let out: DnsRecordDoc | null = null;
    const row = await zones.update(scope, orgId, zoneId, (cur) => {
      const records = [...(cur.records ?? [])];
      const i = records.findIndex((r) => r.name === input.name && r.type === input.type && r.value === input.value);
      const next: DnsRecordDoc =
        i >= 0 ? { ...records[i]!, ttl: input.ttl, priority: input.priority } : { id: newKvId(), ...input };
      if (i >= 0) records[i] = next;
      else records.push(next);
      out = next;
      return { records };
    });
    return row && out ? { ...(out as DnsRecordDoc), orgId, zoneId } : null;
  },

  /** Find a record by id across the org's zones. */
  async findRecord(scope: KvScope, orgId: string, recordId: string): Promise<DnsRecordRow | null> {
    for (const z of await zones.list(scope, orgId)) {
      const r = (z.records ?? []).find((x) => x.id === recordId);
      if (r) return { ...r, orgId, zoneId: z.id };
    }
    return null;
  },

  async removeRecord(scope: KvScope, orgId: string, recordId: string): Promise<boolean> {
    const found = await this.findRecord(scope, orgId, recordId);
    if (!found) return false;
    await zones.update(scope, orgId, found.zoneId, (cur) => ({
      records: (cur.records ?? []).filter((r) => r.id !== recordId),
    }));
    return true;
  },
};
