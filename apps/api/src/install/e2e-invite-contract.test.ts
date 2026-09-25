import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * The e2e smoke (check 4) and the product agree on invite-only sign-up: a
 * stranger is refused, an EMAIL invite needs a proven address (a typed,
 * unverified sign-up is refused), and a LINK invite admits its holder
 * (signup-policy.ts; unit cases in packages/auth/src/signup-policy.test.ts).
 */
const SMOKE = readFileSync(path.resolve(import.meta.dir, '../../../../scripts/e2e-smoke.sh'), 'utf8');
const check4 = SMOKE.slice(SMOKE.indexOf('check_4() {'), SMOKE.indexOf('registry_enforced()'));

describe('e2e check 4 ↔ signup policy', () => {
  it('asserts the three cases', () => {
    expect(check4).toContain('stranger sign-up → $code (want 403)');
    expect(check4).toContain('unverified sign-up for an email invite → $code (want 403)');
    expect(check4).toContain(`trpc_mutate members.invite '{"role":"member"}'`);
    expect(check4).toContain('-H "cookie: swarmy_invite=${inv}"');
    expect(check4).toContain('[ "$code" = 200 ] || { log "sign-up with a link invite');
  });

  it("the script's invite-id extraction matches the link the API mints", () => {
    // Shape of invitations.service inviteLink(): `<base>/login?invite=<id>`.
    const link = 'https://swarmy.example/login?invite=cmfz9x0ab0001qwe';
    const sed = Bun.spawnSync(['sh', '-c', `printf '%s' "$0" | sed -n 's/.*[?&]invite=\\([A-Za-z0-9_-]*\\).*/\\1/p'`, link]);
    expect(sed.stdout.toString().trim()).toBe('cmfz9x0ab0001qwe');
  });
});
