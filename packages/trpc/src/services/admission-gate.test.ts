import { describe, expect, it } from 'bun:test';
import type { OrgContext } from '../context';
import { enforceAdmission } from './admission-gate';

// The network wall throws before any evaluator (or the DB) runs, so a bare ctx suffices.
const ctx = { activeOrgId: 'o1', membership: { role: 'owner' } } as unknown as OrgContext;

describe('enforceAdmission — network wall (not overridable)', () => {
  for (const [label, spec] of [
    ['joins swarmy-control', { name: 'evil_x', networks: ['swarmy-control'] }],
    ['aliases postgres on swarmy', { name: 'evil_pg', networks: ['swarmy'], networkAliases: { swarmy: ['postgres'] } }],
  ] as const) {
    it(`refuses a spec that ${label}, even with an owner override`, async () => {
      for (const mode of ['interactive', 'automation'] as const) {
        const p = enforceAdmission(
          ctx,
          { kind: 'service.deploy', orgId: 'o1', specs: [spec], override: true },
          { targetType: 'service', targetId: spec.name, mode },
        );
        await expect(p).rejects.toThrow(/Deployment blocked by policy/);
      }
    });
  }
});
