import { describe, expect, it } from 'bun:test';
import { JsonPolicyEngine } from './engine';
import { ACTION_CATALOG, describePolicy } from './describe';
import { tryCreateCedarEngine } from './cedar';
import { defaultPolicyInputs } from './defaults';
import { CONFIG_REMOVE_SPECS } from './defaults-config';
import { ACTIONS, type Action, type Principal, type Resource } from './types';

const member: Principal = { userId: 'u1', memberId: 'm1', orgId: 'o1', roles: ['member'], teamIds: [], groups: [], attributes: {} };
const admin: Principal = { ...member, roles: ['admin'] };
const owner: Principal = { ...member, roles: ['owner'] };
const row = (type: string): Resource => ({ type, id: 'r1', orgId: 'o1', labels: {} });

/** [action, resource, member keeps it?] — today's role gate, preserved. */
const CASES: Array<[Action, Resource, boolean]> = [
  ['alert.remove', row('notificationChannel'), true],
  ['alert.remove', row('alertRule'), true],
  ['statuspage.remove', row('statusPage'), true],
  ['job.remove', row('scheduledJob'), true],
  ['ai.remove', row('aiVirtualKey'), true],
  ['ai.remove', row('aiRoute'), true],
  ['webhook.remove', row('inboundEndpoint'), true],
  // adminProcedure before the gate: members stay refused.
  ['webhook.remove', row('webhookEndpoint'), false],
  ['backup.remove', row('backupSchedule'), false],
  ['secret.delete', row('aiProvider'), false],
];

describe('config-level delete actions (owner/admin keep all; members keep what they had)', () => {
  it('are registered and catalogued', () => {
    for (const a of ['alert.remove', 'statuspage.remove', 'webhook.remove', 'job.remove', 'ai.remove'] as const) {
      expect(ACTIONS).toContain(a);
      expect(ACTION_CATALOG.some((c) => c.id === a)).toBe(true);
    }
  });

  it('defaults: owners/admins permitted; members only on the deletes they had', () => {
    const engine = JsonPolicyEngine.withDefaults();
    for (const [action, resource, memberKeeps] of CASES) {
      for (const p of [owner, admin]) expect(engine.evaluate({ principal: p, action, resource }).decision).toBe('permit');
      expect(engine.evaluate({ principal: member, action, resource }).decision).toBe(memberKeeps ? 'permit' : 'deny');
    }
  });

  it('an org-scoped webhook.remove (no typed resource) is not a member permit', () => {
    const engine = JsonPolicyEngine.withDefaults();
    expect(engine.evaluate({ principal: member, action: 'webhook.remove', resource: null }).decision).toBe('deny');
  });

  it('the Cedar engine agrees on every case (when cedar-wasm is installed)', async () => {
    const inputs = defaultPolicyInputs().map((p) => ({ ...p, id: `default:${p.key}` }));
    const cedar = await tryCreateCedarEngine(inputs);
    if (!cedar) return;
    const json = new JsonPolicyEngine(inputs);
    for (const [action, resource] of CASES) {
      for (const p of [owner, admin, member]) {
        expect(cedar.evaluate({ principal: p, action, resource }).decision).toBe(
          json.evaluate({ principal: p, action, resource }).decision,
        );
      }
    }
  });

  it('read as plain words in the rules editor', () => {
    const [config, inbound] = CONFIG_REMOVE_SPECS;
    expect(describePolicy(config!.effect, config!.doc)).toBe(
      'Members can remove alerts, remove status pages, remove scheduled jobs and revoke AI keys and routes.',
    );
    expect(describePolicy(inbound!.effect, inbound!.doc)).toBe('Members can remove webhooks on inbound webhooks.');
  });
});
