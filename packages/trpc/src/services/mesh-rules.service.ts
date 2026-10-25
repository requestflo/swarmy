/**
 * Mesh access rules on Mesh settings (board 43): who can reach whom on the
 * private network, in plain words ("Servers can reach Databases on 5432").
 *
 * The rules live in the provider (NetBird policies), never in swarmy: every
 * read goes to the control plane through the driver's OPTIONAL access-rule
 * methods (@swarmy/mesh MeshDriver). NetBird implements them; Headscale and
 * `none` leave them out, so the view says rules aren't available there.
 * Adding or removing a simple rule is `mesh.rules` (owner/admin by default)
 * and audited; swarmy's own rules (servers ↔ servers, people access) are
 * listed but never changed here.
 */
import { MeshAccessRuleRefused, MeshControlPlaneError, accessRuleWords, getDriver, type DriverControlPlane, type MeshAccessRule, type MeshDriver, type NewMeshAccessRule } from '@swarmy/mesh';
import { TRPCError } from '@trpc/server';
import type { OrgContext } from '../context';
import { stacks } from './apps.repo';
import { writeAudit } from './audit.service';
import { meshConfigRepo, type MeshConfigRow } from './mesh-config.repo';
import { managedAdmin } from './mesh-control.service';
import { makeControlPlane, toOrgConfig } from './mesh.service';

export interface MeshAccessRuleView extends MeshAccessRule {
  /** The rule in plain words. */
  words: string;
}

export interface MeshAccessRulesView {
  /** The org's driver can list rules (NetBird). */
  supported: boolean;
  /** Why there is nothing to list, in plain words (mesh off, a driver without rules). */
  note: string | null;
  rules: MeshAccessRuleView[];
  /** Groups a new rule may name. */
  groups: string[];
  /** The control plane couldn't be read just now. */
  error: string | null;
}

interface Bound {
  driver: MeshDriver;
  config: ReturnType<typeof toOrgConfig>;
  control: DriverControlPlane;
}

/** The driver + control plane for the org; a managed NetBird is reached on its direct admin URL first. */
function bind(ctx: OrgContext, row: MeshConfigRow): Bound | { note: string } {
  const config = toOrgConfig(ctx, row);
  if (!row.enabled || config.driver === 'none') return { note: 'The private network is off, so there are no rules yet.' };
  const driver = getDriver(config.driver);
  if (!driver.listAccessRules) {
    return { note: `${config.driver === 'headscale' ? 'Headscale keeps its rules in its own policy file' : 'This mesh driver has no rules swarmy can read'}; swarmy doesn't list them yet.` };
  }
  const control = makeControlPlane(config);
  const admin = managedAdmin(row);
  return { driver, config, control: admin ? { ...control, policies: admin } : control };
}

async function stackNames(ctx: OrgContext): Promise<{ id: string; name: string }[]> {
  return (await stacks(ctx, ctx.activeOrgId)
    .findMany({ where: { orgId: ctx.activeOrgId }, select: { id: true, name: true } })
    .catch(() => [])) as { id: string; name: string }[];
}

const plain = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export async function listAccessRules(ctx: OrgContext): Promise<MeshAccessRulesView> {
  const b = bind(ctx, await meshConfigRepo.get(ctx, ctx.activeOrgId));
  if ('note' in b) return { supported: false, note: b.note, rules: [], groups: [], error: null };
  try {
    const list = await b.driver.listAccessRules!(b.config, b.control);
    const names = { stacks: await stackNames(ctx) };
    return { supported: true, note: null, rules: list.rules.map((r) => ({ ...r, words: accessRuleWords(r, names) })), groups: list.groups, error: null };
  } catch (e) {
    return { supported: true, note: null, rules: [], groups: [], error: `Couldn't read the rules from the control plane: ${plain(e)}` };
  }
}

async function mustBind(ctx: OrgContext, method: 'addAccessRule' | 'removeAccessRule'): Promise<Bound> {
  const b = bind(ctx, await meshConfigRepo.get(ctx, ctx.activeOrgId));
  if ('note' in b || !b.driver[method]) throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'note' in b ? b.note : "this mesh driver's rules can't be changed from swarmy" });
  return b;
}

function rethrow(e: unknown): never {
  if (e instanceof MeshAccessRuleRefused) throw new TRPCError({ code: 'BAD_REQUEST', message: e.message });
  if (e instanceof MeshControlPlaneError) throw new TRPCError({ code: 'PRECONDITION_FAILED', message: e.message });
  throw e;
}

/** Add a simple rule (`mesh.rules`, audited): one group may reach another on some ports. */
export async function addAccessRule(ctx: OrgContext, rule: NewMeshAccessRule): Promise<MeshAccessRulesView> {
  const b = await mustBind(ctx, 'addAccessRule');
  const created = await b.driver.addAccessRule!(b.config, rule, b.control).catch(rethrow);
  await writeAudit(ctx, {
    action: 'mesh.rule.add',
    targetType: 'meshRule',
    targetId: created.id,
    metadata: { name: created.name, from: rule.from, to: rule.to, protocol: rule.protocol, ports: rule.ports, words: accessRuleWords(created) },
  });
  return listAccessRules(ctx);
}

/** Remove a simple rule that isn't swarmy's own (`mesh.rules`, audited). */
export async function removeAccessRule(ctx: OrgContext, id: string): Promise<MeshAccessRulesView> {
  const b = await mustBind(ctx, 'removeAccessRule');
  const before = (await b.driver.listAccessRules!(b.config, b.control).catch(rethrow)).rules.find((r) => r.id === id);
  await b.driver.removeAccessRule!(b.config, id, b.control).catch(rethrow);
  await writeAudit(ctx, {
    action: 'mesh.rule.remove',
    targetType: 'meshRule',
    targetId: id,
    metadata: { name: before?.name ?? null, words: before ? accessRuleWords(before, { stacks: await stackNames(ctx) }) : null },
  });
  return listAccessRules(ctx);
}
