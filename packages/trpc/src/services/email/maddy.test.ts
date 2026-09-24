import { describe, expect, it } from 'bun:test';
import {
  MADDY_IMAGE,
  maddyBcrypt,
  maddyBundle,
  mailServiceSpec,
  q,
  relayRouteName,
  renderMaddyConfig,
  renderSendersTable,
  renderUsersTable,
  staleMailSecrets,
  type MaddyRenderInput,
} from './maddy';
import { SYSTEM_IMAGES } from '@swarmy/core/system-images';

const input: MaddyRenderInput = {
  hostname: 'mail.example.com',
  domains: [
    { domain: 'example.com', selector: 'swarmy', dkimPrivateKeyPem: 'KEY1', relay: null },
    { domain: 'shop.test', selector: 'swarmy', dkimPrivateKeyPem: 'KEY2', relay: { host: 'smtp.relay.test', port: 587, security: 'starttls', username: 'u', password: 'p w"x' } },
  ],
  users: [
    { username: 'web.abc123@swarmy', passwordHash: 'bcrypt:$2a$10$aaa', domains: ['example.com'] },
    { username: 'swarmy-system.abc123@swarmy', passwordHash: 'bcrypt:$2a$10$bbb', domains: ['example.com', 'shop.test'] },
  ],
  suppressed: ['Gone@Example.org', 'not an address', 'gone@example.org'],
  bounceHook: { host: 'swarmy_controller', port: 2525, username: 'maddy', password: 'tok' },
};

describe('renderMaddyConfig', () => {
  const conf = renderMaddyConfig(input);

  it('submission on 587 requires auth and restricts senders per credential', () => {
    expect(conf).toContain('submission tcp://0.0.0.0:587 {');
    expect(conf).toContain('    auth &swarmy_auth');
    expect(conf).toContain('user_to_email &swarmy_senders');
    expect(conf).toContain('reject 501 5.1.8 "sender domain is not set up in swarmy"');
  });

  it('one route per delivery path: direct MX and each smarthost', () => {
    expect(conf).toContain('target.remote direct_target {');
    const relay = relayRouteName(input.domains[1]!.relay!);
    expect(conf).toContain(`target.smtp ${relay}_target {`);
    expect(conf).toContain('    targets tcp://smtp.relay.test:587');
    expect(conf).toContain('    starttls yes');
    expect(conf).toContain('    auth plain u "p w\\"x"');
    expect(conf).toContain('    source example.com {');
    expect(conf).toContain(`            deliver_to &${relay}_queue`);
  });

  it('DKIM signs every route from the mounted per-domain keys', () => {
    expect(conf).toContain('key_path /run/secrets/dkim-{domain}-{selector}.key');
    expect(conf).toContain('                domains shop.test');
  });

  it('DSNs from every queue go to the controller bounce hook, authenticated', () => {
    expect(conf).toContain('targets tcp://swarmy_controller:2525');
    expect(conf).toContain('auth plain maddy tok');
    expect(conf.match(/deliver_to &swarmy_bounce_hook/g)).toHaveLength(2);
  });

  it('suppressed recipients are refused at submission (deduped, lowercased, valid only)', () => {
    expect(conf).toContain('destination gone@example.org {');
    expect(conf).not.toContain('not an address');
  });

  it('is deterministic (stable secret names ⇒ no restart loop)', () => {
    const shuffled = { ...input, domains: [...input.domains].reverse(), users: [...input.users].reverse() };
    expect(maddyBundle(shuffled).signature).toBe(maddyBundle(input).signature);
    expect(renderMaddyConfig(shuffled)).toBe(conf);
  });

  it('newlines in values can never inject directives', () => {
    expect(q('a\nsubmission tcp://0.0.0.0:25 {')).not.toContain('\n');
  });
});

describe('tables + bundle', () => {
  it('pass table and sender table', () => {
    expect(renderUsersTable(input.users)).toBe('swarmy-system.abc123@swarmy: bcrypt:$2a$10$bbb\nweb.abc123@swarmy: bcrypt:$2a$10$aaa\n');
    expect(renderSendersTable(input.users)).toBe(
      'swarmy-system.abc123@swarmy: example.com\nswarmy-system.abc123@swarmy: shop.test\nweb.abc123@swarmy: example.com\n',
    );
  });

  it('every file is a content-addressed Docker secret; the spec mounts them all', () => {
    const b = maddyBundle(input);
    expect(b.all.map((s) => s.target)).toEqual(['maddy.conf', 'users', 'senders', 'dkim-example.com-swarmy.key', 'dkim-shop.test-swarmy.key']);
    expect(b.all.every((s) => /^swarmy-mail-[a-z0-9.-]+-[0-9a-f]{8}$/.test(s.name))).toBe(true);
    const spec = mailServiceSpec({ bundle: b, pinSwarmNodeId: 'n1' });
    expect(spec.image).toBe(MADDY_IMAGE);
    expect(spec.ports).toBeUndefined();
    expect(spec.networks).toEqual(['swarmy', 'swarmy-control']);
    expect(spec.secrets?.map((s) => s.source)).toEqual(b.all.map((s) => s.name));
    expect(spec.placement?.constraints).toEqual(['node.id==n1']);
    expect(spec.args).toEqual(['-config', '/run/secrets/maddy.conf', 'run']);
    expect(staleMailSecrets(['swarmy-mail-config-00000000', b.config.name, 'other'], b.all.map((s) => s.name))).toEqual(['swarmy-mail-config-00000000']);
  });

  it('the image is pinned in the system-image BOM', () => {
    const bom = SYSTEM_IMAGES.find((i) => i.ref === MADDY_IMAGE);
    expect(bom?.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('bcrypt hashes are handed to maddy as $2a$', () => {
    expect(maddyBcrypt('$2b$10$xyz')).toBe('bcrypt:$2a$10$xyz');
  });
});
