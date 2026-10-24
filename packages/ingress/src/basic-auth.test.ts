import { describe, expect, it } from 'bun:test';
import { BasicAuthRuleInputSchema, caddyBasicAuthLines, redactBcryptHashes } from './basic-auth';
import { RouteProtectionInputSchema, RouteProtectionSchema } from './types';

const H = '$2a$04$s9UrunJ5THGBb7K3rf97.O.h.mHLDwhTHpeBbrK4gp4cfHTgn2ioK';
const REF = 'rpw_0123456789abcdef';

describe('basic auth shapes (a password never reaches a label)', () => {
  it('a write brings either a new password or the stored reference, never both or neither', () => {
    const ok = (users: unknown[]) => BasicAuthRuleInputSchema.safeParse({ users }).success;
    expect(ok([{ username: 'alice', password: 'correct horse' }])).toBe(true);
    expect(ok([{ username: 'alice', passwordSecret: REF }])).toBe(true);
    expect(ok([{ username: 'alice', password: 'correct horse', passwordSecret: REF }])).toBe(false);
    expect(ok([{ username: 'alice' }])).toBe(false);
    expect(ok([{ username: 'alice', password: 'short' }])).toBe(false);
    expect(ok([])).toBe(false);
  });

  it('the write shape accepts a password; the label shape drops it', () => {
    const input = { basicAuth: { users: [{ username: 'alice', password: 'correct horse' }] } };
    expect(RouteProtectionInputSchema.safeParse(input).success).toBe(true);
    expect(RouteProtectionSchema.safeParse(input).success).toBe(false);
  });

  it('renders one line per user (first wins on a repeated name) and fails closed on none', () => {
    expect(caddyBasicAuthLines({ users: [{ username: 'alice', hash: H }, { username: 'alice', hash: H }] })).toEqual([
      'basic_auth {',
      `  alice ${H}`,
      '}',
    ]);
    expect(caddyBasicAuthLines({ users: [] })).toEqual(['respond "This address needs a password that is not set up yet" 503']);
  });

  it('the preview hides every hash', () => {
    expect(redactBcryptHashes(`basic_auth {\n  alice ${H}\n}`)).toBe('basic_auth {\n  alice <bcrypt hash, sealed in swarmy>\n}');
  });
});
