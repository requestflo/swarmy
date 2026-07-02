import { describe, expect, it } from 'bun:test';
import {
  PROMOTION_GRACE_TICKS,
  choosePromotionTarget,
  formatLagSeconds,
  lagLabelUpdates,
  lsnDiffBytes,
  minuteDue,
  parseLagOutput,
  parseLsn,
  parseScheduleLite,
  pitrVersion,
  promotionDue,
  renderWalCredsEnv,
  shipperScript,
} from './manageddb-reconcile.core';

/**
 * Pure A2 pitr-ha helpers: promotion due-ness/choice, LSN math, lag parsing and
 * stamping, the wal-creds env render and the once-per-minute backup gate. No
 * network, no DB — mirrors the geodns-provider test style.
 */

describe('promotionDue — grace window (strictly more than N unhealthy ticks)', () => {
  it('holds through the grace window, fires after it', () => {
    expect(promotionDue(0)).toBe(false);
    expect(promotionDue(PROMOTION_GRACE_TICKS)).toBe(false);
    expect(promotionDue(PROMOTION_GRACE_TICKS + 1)).toBe(true);
  });

  it('honours a custom grace', () => {
    expect(promotionDue(5, 5)).toBe(false);
    expect(promotionDue(6, 5)).toBe(true);
  });
});

describe('choosePromotionTarget — lowest-lag running replica', () => {
  it('picks the lowest lag among running candidates', () => {
    expect(
      choosePromotionTarget([
        { service: 'a', running: 1, lagSeconds: 4.2 },
        { service: 'b', running: 1, lagSeconds: 0.3 },
        { service: 'c', running: 1, lagSeconds: 12 },
      ]),
    ).toBe('b');
  });

  it('disqualifies members with no running task', () => {
    expect(
      choosePromotionTarget([
        { service: 'a', running: 0, lagSeconds: 0 },
        { service: 'b', running: 2, lagSeconds: 9 },
      ]),
    ).toBe('b');
  });

  it('unmeasured lag sorts last (a measured replica always wins)', () => {
    expect(
      choosePromotionTarget([
        { service: 'a', running: 1, lagSeconds: null },
        { service: 'b', running: 1, lagSeconds: 30 },
      ]),
    ).toBe('b');
  });

  it('ties break on LSN diff, then stable name order', () => {
    expect(
      choosePromotionTarget([
        { service: 'b', running: 1, lagSeconds: 1, lsnDiffBytes: 2048 },
        { service: 'a', running: 1, lagSeconds: 1, lsnDiffBytes: 128 },
      ]),
    ).toBe('a');
    expect(
      choosePromotionTarget([
        { service: 'b', running: 1, lagSeconds: 1 },
        { service: 'a', running: 1, lagSeconds: 1 },
      ]),
    ).toBe('a');
  });

  it('returns null when nothing is promotable', () => {
    expect(choosePromotionTarget([])).toBeNull();
    expect(choosePromotionTarget([{ service: 'a', running: 0, lagSeconds: 1 }])).toBeNull();
  });
});

describe('LSN math', () => {
  it('parses hi/lo hex into absolute bytes', () => {
    expect(parseLsn('0/0')).toBe(0);
    expect(parseLsn('0/1000')).toBe(0x1000);
    expect(parseLsn('16/B374D848')).toBe(0x16 * 0x1_0000_0000 + 0xb374d848);
  });

  it('rejects garbage', () => {
    expect(parseLsn('')).toBeNull();
    expect(parseLsn('not-an-lsn')).toBeNull();
    expect(parseLsn('1/2/3')).toBeNull();
  });

  it('diffs primary vs replica, clamped at 0', () => {
    expect(lsnDiffBytes('0/2000', '0/1000')).toBe(0x1000);
    expect(lsnDiffBytes('0/1000', '0/2000')).toBe(0); // replica ahead → clamp
    expect(lsnDiffBytes('junk', '0/1000')).toBeNull();
  });
});

describe('parseLagOutput — replica psql sample (`<secs>|<lsn>`)', () => {
  it('parses seconds + replay lsn', () => {
    expect(parseLagOutput('0.412345|0/3000060\n')).toEqual({
      lagSeconds: 0.4,
      replayLsn: '0/3000060',
    });
  });

  it('handles an idle replica (no replay lsn) and clamps negatives', () => {
    expect(parseLagOutput('-0.2|')).toEqual({ lagSeconds: 0, replayLsn: null });
  });

  it('rejects noise', () => {
    expect(parseLagOutput('')).toBeNull();
    expect(parseLagOutput('ERROR: whatever')).toBeNull();
  });
});

describe('lagLabelUpdates — change-gated swarmy.db.lag.* stamping', () => {
  const key = (m: string): string => `swarmy.db.lag.${m}`;

  it('is null when nothing changed (steady state = zero service updates)', () => {
    expect(lagLabelUpdates({ [key('r1')]: '0.4' }, { r1: 0.44 }, ['p', 'r1'])).toBeNull();
  });

  it('adds new/changed members and formats to one decimal', () => {
    const u = lagLabelUpdates({ [key('r1')]: '0.4' }, { r1: 7.25, r2: 0 }, ['p', 'r1', 'r2']);
    expect(u).toEqual({ add: { [key('r1')]: '7.3', [key('r2')]: '0' }, removeKeys: [] });
  });

  it('removes stamps for members that left the cluster, keeps quiet ones', () => {
    const u = lagLabelUpdates({ [key('gone')]: '2', [key('quiet')]: '1' }, { r1: 1 }, ['p', 'r1', 'quiet']);
    expect(u).toEqual({ add: { [key('r1')]: '1' }, removeKeys: [key('gone')] });
  });

  it('formatLagSeconds clamps + rounds', () => {
    expect(formatLagSeconds(-1)).toBe('0');
    expect(formatLagSeconds(10.06)).toBe('10.1');
  });
});

describe('minuteDue — the once-per-minute backup sweep gate', () => {
  it('fires immediately, then only after 60s', () => {
    expect(minuteDue(null, 1_000)).toBe(true);
    expect(minuteDue(1_000, 30_000)).toBe(false);
    expect(minuteDue(1_000, 61_000)).toBe(true);
  });
});

describe('renderWalCredsEnv — the wal-shipper Docker-secret env file', () => {
  it('derives WALG_S3_PREFIX exactly like the agent physicalEnv (bucket+prefix)', () => {
    const env = renderWalCredsEnv({
      endpoint: 's3.eu-central-003.backblazeb2.com',
      bucket: 'northwind-backups',
      prefix: '/restic',
      region: 'eu-central-003',
      accessKeyId: 'AKIA',
      secretAccessKey: 'shh',
    });
    expect(env).toContain('WALG_S3_PREFIX=s3://northwind-backups/restic\n');
    expect(env).toContain('AWS_ENDPOINT=https://s3.eu-central-003.backblazeb2.com\n');
    expect(env).toContain('AWS_ACCESS_KEY_ID=AKIA\n');
    expect(env).toContain('AWS_SECRET_ACCESS_KEY=shh\n');
    expect(env).toContain('AWS_REGION=eu-central-003\n');
    expect(env.endsWith('\n')).toBe(true);
  });

  it('omits absent creds/region and keeps a schemeful endpoint as-is', () => {
    const env = renderWalCredsEnv({
      endpoint: 'http://garage:3900',
      bucket: 'b',
      prefix: null,
      region: null,
      accessKeyId: null,
      secretAccessKey: null,
    });
    expect(env).toContain('WALG_S3_PREFIX=s3://b\n');
    expect(env).toContain('AWS_ENDPOINT=http://garage:3900\n');
    expect(env).not.toContain('AWS_ACCESS_KEY_ID');
    expect(env).not.toContain('AWS_REGION');
  });

  it('pitrVersion is stable for identical wiring, distinct otherwise', () => {
    const a = renderWalCredsEnv({ endpoint: 'e', bucket: 'b', prefix: null, region: null, accessKeyId: 'k', secretAccessKey: 's' });
    expect(pitrVersion(a, 'vol')).toBe(pitrVersion(a, 'vol'));
    expect(pitrVersion(a, 'vol')).not.toBe(pitrVersion(a, 'other'));
    expect(pitrVersion(a, undefined)).not.toBe(pitrVersion(`${a}x`, undefined));
    expect(pitrVersion(a, 'vol')).toMatch(/^[0-9a-f]{10}$/);
  });
});

describe('parseScheduleLite — PITR fields off the schedule label', () => {
  it('extracts targetId + dataVolume, tolerating extra fields', () => {
    const raw = JSON.stringify({
      cron: '0 */6 * * *',
      engine: 'wal-g',
      retentionDays: 14,
      pitr: true,
      targetId: 'tgt-1',
      dataVolume: 'shop_main-data',
    });
    expect(parseScheduleLite(raw)).toEqual({ targetId: 'tgt-1', dataVolume: 'shop_main-data' });
  });

  it('degrades on malformed JSON / non-objects', () => {
    expect(parseScheduleLite(undefined)).toBeNull();
    expect(parseScheduleLite('{nope')).toBeNull();
    expect(parseScheduleLite('[1]')).toBeNull();
    expect(parseScheduleLite('{}')).toEqual({});
  });
});

describe('shipperScript — the wal-push loop', () => {
  it('sources the mounted secret, pushes then deletes segments', () => {
    const s = shipperScript();
    expect(s).toContain('. /run/secrets/wal-creds');
    expect(s).toContain('wal-g wal-push "$f"');
    expect(s).toContain('rm -f -- "$f"');
    expect(s).toContain('/wal-archive/*');
  });
});
