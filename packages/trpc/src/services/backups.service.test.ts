import { describe, expect, it } from 'bun:test';
import {
  STACK_RETENTION_LABEL,
  parseRetentionDays,
  stackRetentionFor,
} from './backups.service';

function svc(stack: string, labels: Record<string, string> = {}): {
  stack: string;
  labels: Record<string, string>;
} {
  return { stack, labels };
}

describe('parseRetentionDays (swarmy.backup.retentionDays label value)', () => {
  it('parses whole days in 1..3650', () => {
    expect(parseRetentionDays('30')).toBe(30);
    expect(parseRetentionDays('1')).toBe(1);
    expect(parseRetentionDays('3650')).toBe(3650);
  });

  it('degrades anything else to null (keep forever) instead of throwing', () => {
    expect(parseRetentionDays(undefined)).toBeNull();
    expect(parseRetentionDays(null)).toBeNull();
    expect(parseRetentionDays('')).toBeNull();
    expect(parseRetentionDays('0')).toBeNull();
    expect(parseRetentionDays('-7')).toBeNull();
    expect(parseRetentionDays('3651')).toBeNull();
    expect(parseRetentionDays('7.5')).toBeNull();
    expect(parseRetentionDays('soon')).toBeNull();
  });
});

describe('stackRetentionFor (volume → stack retention attribution)', () => {
  it('reads the retention label off the volume\'s stack', () => {
    const services = [
      svc('shop', { [STACK_RETENTION_LABEL]: '30' }),
      svc('blog', { [STACK_RETENTION_LABEL]: '7' }),
    ];
    expect(stackRetentionFor(services, 'shop_db-data')).toBe(30);
    expect(stackRetentionFor(services, 'blog_uploads')).toBe(7);
  });

  it('returns null when the stack has no retention label (keep forever)', () => {
    expect(stackRetentionFor([svc('shop')], 'shop_db-data')).toBeNull();
  });

  it('returns null for volumes no live stack claims', () => {
    expect(stackRetentionFor([svc('shop', { [STACK_RETENTION_LABEL]: '30' })], 'other_data')).toBeNull();
  });

  it('attributes to the LONGEST matching stack — `shop` must not claim shop_x volumes', () => {
    const services = [
      svc('shop', { [STACK_RETENTION_LABEL]: '30' }),
      svc('shop_x', { [STACK_RETENTION_LABEL]: '5' }),
    ];
    expect(stackRetentionFor(services, 'shop_x_data')).toBe(5);
    expect(stackRetentionFor(services, 'shop_data')).toBe(30);
  });

  it('keeps the LONGEST window when a partial stamp leaves services disagreeing', () => {
    const services = [
      svc('shop', { [STACK_RETENTION_LABEL]: '7' }),
      svc('shop', { [STACK_RETENTION_LABEL]: '30' }),
      svc('shop'),
    ];
    expect(stackRetentionFor(services, 'shop_db-data')).toBe(30);
  });
});
