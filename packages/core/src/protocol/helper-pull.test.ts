import { describe, expect, it } from 'bun:test';
import { AppDbCreds } from './appDb';
import { AGENT_CAPABILITIES, AGENT_CAPABILITY, agentSupports } from './capabilities';
import { HELPER_FALLBACK_FIELD } from './helper-pull';
import { ControllerToAgentMessage, parseControllerEnvelope } from './messages';

// Mirrored helper images (air-gapped clusters): every backup/restore/dump
// command carries an optional upstream fallback per helper field plus the
// mirror login. Additive: a payload without them parses exactly as before.
const CID = '00000000-0000-4000-8000-000000000001';
const D = `sha256:${'a'.repeat(64)}`;
const MIRROR = `localhost:5000/swarmy-system/docker.io/restic/restic:0.16.4@${D}`;
const UP = `restic/restic:0.16.4@${D}`;
const AUTH = { username: 'swarmy', password: 'pw', server: 'localhost:5000' };
const repo = { kind: 's3' as const, repo: 's3:http://swarmy-garage:3900/b/p', password: 'pw' };
const conn = { host: 'pg', password: 'x' };
const creds = AppDbCreds.parse({ scope: 'root', password: [{ kind: 'env', name: 'MYSQL_ROOT_PASSWORD' }], port: 3306 });
const appdb = { service: 'wp_db', creds, repo };

/** Each wire type, a minimal payload, and the helper fields it carries. */
const CASES: { type: string; base: Record<string, unknown>; fields: (keyof typeof HELPER_FALLBACK_FIELD)[] }[] = [
  { type: 'backupVolume', base: { commandId: CID, jobId: 'j', repo, volume: 'shop_data' }, fields: ['image'] },
  { type: 'restoreVolume', base: { commandId: CID, repo, targetVolume: 'shop_data' }, fields: ['image'] },
  { type: 'listSnapshots', base: { commandId: CID, repo }, fields: ['image'] },
  { type: 'dbBackup', base: { commandId: CID, jobId: 'j', engine: 'wal-g', conn, repo }, fields: ['resticImage', 'clientImage', 'engineImage'] },
  { type: 'dbRestore', base: { commandId: CID, engine: 'pg_dump', mode: 'in-place', conn, repo }, fields: ['resticImage', 'clientImage', 'engineImage'] },
  { type: 'appDbBackup', base: { commandId: CID, jobId: 'j', engine: 'mysql', ...appdb, host: 'h' }, fields: ['resticImage'] },
  { type: 'appDbRestore', base: { commandId: CID, engine: 'mysql', mode: 'copy', ...appdb, snapshotId: 'abc', suffix: 'c1' }, fields: ['resticImage'] },
  { type: 'appDbVerify', base: { commandId: CID, engine: 'mysql', image: 'mysql:8', repo, snapshotId: 'abc' }, fields: ['resticImage'] },
  { type: 'dbPitrWindow', base: { commandId: CID, engine: 'wal-g', repo }, fields: ['engineImage'] },
  { type: 'dbWalVerify', base: { commandId: CID, engine: 'wal-g', repo, conn }, fields: ['engineImage'] },
];

const parse = (type: string, payload: Record<string, unknown>) => ControllerToAgentMessage.safeParse({ type, payload });

describe('helper fallbacks on every backup/restore/dump command (round-trip gate)', () => {
  for (const c of CASES) {
    it(`${c.type}: absent fields parse as before; mirrored + fallback + login round-trip`, () => {
      const plain = parse(c.type, c.base);
      expect(plain.success).toBe(true);
      const pp = plain.data?.payload as Record<string, unknown>;
      for (const f of c.fields) expect(pp[HELPER_FALLBACK_FIELD[f]]).toBeUndefined();
      expect(pp.registryAuth).toBeUndefined();

      const sent: Record<string, unknown> = { ...c.base, registryAuth: AUTH };
      for (const f of c.fields) Object.assign(sent, { [f]: MIRROR, [HELPER_FALLBACK_FIELD[f]]: UP });
      const out = parse(c.type, JSON.parse(JSON.stringify(sent)));
      expect(out.success).toBe(true);
      const op = out.data?.payload as Record<string, unknown>;
      for (const f of c.fields) expect([op[f], op[HELPER_FALLBACK_FIELD[f]]]).toEqual([MIRROR, UP]);
      expect(op.registryAuth).toEqual(AUTH);
      expect(parse(c.type, JSON.parse(JSON.stringify(op))).data).toEqual(out.data!);

      const env = parseControllerEnvelope({ v: 1, id: '33333333-3333-4333-8333-333333333333', ts: 1, type: c.type, payload: sent });
      expect(env.type).toBe(c.type as never);
    });

    it(`${c.type}: a partial login or a non-string fallback is rejected, and so is a wrong type`, () => {
      expect(parse(c.type, { ...c.base, registryAuth: { username: 'swarmy' } }).success).toBe(false);
      expect(parse(c.type, { ...c.base, [HELPER_FALLBACK_FIELD[c.fields[0]!]]: 42 }).success).toBe(false);
      expect(parse('deployService', { ...c.base, registryAuth: AUTH }).success).toBe(false);
    });
  }
});

describe('the helperImageMirror capability gates the rewrite', () => {
  it('this agent advertises it; an agent that predates it does not', () => {
    expect(AGENT_CAPABILITIES).toContain(AGENT_CAPABILITY.helperImageMirror);
    expect(agentSupports(['dbPitrWindow'], AGENT_CAPABILITY.helperImageMirror)).toBe(false);
    expect(agentSupports(undefined, AGENT_CAPABILITY.helperImageMirror)).toBe(false);
  });
});
