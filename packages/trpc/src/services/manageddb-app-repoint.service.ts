import {
  DB_PASSWORD_SECRET_LABEL,
  appRepointMessage,
  buildInventory,
  clusterDatabase,
  parseDbSecretName,
  planAppRepoint,
  type AppRepointMove,
  type RepointStandby,
} from '@swarmy/core';
import type { OrgContext } from '../context';
import { writeAudit } from './audit.service';
import { resolveManagerNode } from './dispatch.service';
import { recordIncidentEvent } from './incidents-record';
import { clusterNetworkName, readDbPassword, roVarName } from './manageddb.service';
import { wireAppUrlSecrets } from './manageddb-app-wire';
import { listDbSecrets, mintDbUrlSecret, retireUrlSecrets } from './manageddb-url-secrets';

/**
 * Apps follow the writer (the manageddb reconcile's promotion pass, and each
 * tick after it until nothing is left): every app wired DIRECTLY to the
 * cluster whose URL still names another host gets its DATABASE_URL re-minted
 * for the writer as a new secret version (and its read-only URL moved off the
 * promoted copy), then rolls onto it, start-first where it allows. The plan is
 * pure (@swarmy/core `planAppRepoint`); apps through the pooler are never
 * touched. An app that moved is on the incident timeline ("Repointed shop_api
 * at …") and the cluster's audit trail (`db.repoint.app`, system); the URL
 * versions nothing mounts any more go. Resumable: an app that didn't move
 * (a restart mid-pass, a failed redeploy) still names the old host, so the
 * next call moves it, reusing the secret the others got.
 */

export interface RepointAppsInput {
  stack: string;
  cluster: string;
  /** The writer's service. Default: the live base primary. The promotion pass names it (its labels are not flipped in the inventory yet). */
  writer?: string;
  /** The standby copies and whether each runs. Default: the live replica-role members. */
  standbys?: RepointStandby[];
}

export interface RepointAppsResult {
  writer: string;
  moved: Array<Pick<AppRepointMove, 'service' | 'from' | 'ro'>>;
  failed: Array<{ service: string; error: string }>;
  retired: string[];
}

export async function repointDbApps(ctx: OrgContext, input: RepointAppsInput): Promise<RepointAppsResult> {
  const { stack, cluster } = input;
  const { services: live, containers } = ctx.hub.liveInventory(ctx.activeOrgId);
  const services = buildInventory(live, containers).services.filter((s) => s.stack === stack);
  const members = services.filter((s) => s.labels['swarmy.db.cluster'] === cluster && s.labels['swarmy.db.engine']);
  const writer = input.writer ?? members.find((s) => s.labels['swarmy.db.role'] === 'primary' && !s.labels['swarmy.db.member'])?.name;
  const out: RepointAppsResult = { writer: writer ?? '', moved: [], failed: [], retired: [] };
  const writerSvc = members.find((s) => s.name === writer);
  if (!writer || !writerSvc) return out;
  const standbys =
    input.standbys ??
    members
      .filter((s) => s.labels['swarmy.db.role'] === 'replica')
      .map((s) => ({ service: s.name, running: s.replicas.running, ...(s.labels['swarmy.db.region'] ? { region: s.labels['swarmy.db.region'] } : {}) }));
  const plan = planAppRepoint({ stack, cluster, writer, standbys, services });
  if (plan.moves.length === 0) return out; // steady: nothing dispatched

  const node = await resolveManagerNode(ctx);
  const password = await readDbPassword(ctx, stack, cluster);
  const database = clusterDatabase([writerSvc, ...members]);
  const secret = writerSvc.labels[DB_PASSWORD_SECRET_LABEL];
  const floor = secret ? parseDbSecretName(secret)?.version ?? 1 : 1;
  const listed = await listDbSecrets(ctx, node.id);
  const url = (host: string) => `postgres://postgres:${password}@${host}:5432/${database}`;
  const mint = (kind: 'url' | 'ro-url', host: string) => mintDbUrlSecret(ctx, node.id, { stack, cluster, kind, value: url(host), host, floor }, listed);
  const keep = new Set<string>();
  const ref = `${stack}/${cluster}`;

  for (const m of plan.moves) {
    const app = services.find((s) => s.name === m.service)!;
    try {
      const rwSecret = await mint('url', writer);
      const roSecret = await mint('ro-url', m.ro);
      const wiring = { stack, cluster, envVar: m.envVar, roVar: roVarName(m.envVar), via: 'direct' as const, network: clusterNetworkName(stack, cluster) };
      await wireAppUrlSecrets(ctx, app, { ...wiring, rwSecret, roSecret, rwHost: writer, roHost: m.ro, rolling: true }, node.id);
      keep.add(rwSecret).add(roSecret);
      out.moved.push({ service: m.service, from: m.from, ro: m.ro });
    } catch (e) {
      out.failed.push({ service: m.service, error: e instanceof Error ? e.message : String(e) });
      continue;
    }
    const meta = { app: m.service, from: m.from, to: writer, roFrom: m.roFrom, ro: m.ro };
    await recordIncidentEvent(ctx, { groupKey: `db:${ref}`, kind: 'db.repoint.app', message: appRepointMessage(m, writer), severity: 'warning', meta }).catch(() => undefined);
    await writeAudit(ctx, { action: 'db.repoint.app', actorType: 'system', targetType: 'dbCluster', targetId: ref, metadata: meta });
  }
  // The versions the moved apps left behind (Docker keeps any still mounted).
  if (out.moved.length > 0) {
    out.retired = await retireUrlSecrets(ctx, node.id, { stack, cluster, kinds: ['url', 'ro-url'], keep });
  }
  return out;
}
