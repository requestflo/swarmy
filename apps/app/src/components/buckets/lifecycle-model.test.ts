import { describe, expect, it } from 'bun:test';
import type { LifecycleRuleView } from '@swarmy/core';
import { agePosition, fmtDays, lifeSay, lifecycleCode, ruleDoes } from './lifecycle-model';

const rule = (over: Partial<LifecycleRuleView>): LifecycleRuleView => ({
  id: 'r',
  enabled: true,
  prefix: '',
  expireAfterDays: null,
  abortUploadsAfterDays: null,
  expireOnDate: null,
  sizeGreaterThan: null,
  sizeLessThan: null,
  ...over,
});

describe('agePosition (the board 42 axis)', () => {
  it('lands on the marks and keeps forever at the end', () => {
    expect(agePosition(0)).toBe(0);
    expect(agePosition(7)).toBeCloseTo(25);
    expect(agePosition(30)).toBeCloseTo(50);
    expect(agePosition(365)).toBeCloseTo(75);
    expect(agePosition(null)).toBe(100);
  });

  it('grows between marks and never reaches forever', () => {
    expect(agePosition(14)).toBeGreaterThan(25);
    expect(agePosition(14)).toBeLessThan(50);
    expect(agePosition(100_000)).toBe(95);
  });
});

describe('words', () => {
  it('formats days and years', () => {
    expect([1, 7, 30, 365, 730, 400].map(fmtDays)).toEqual(['1 day', '7 days', '30 days', '1 year', '2 years', '400 days']);
  });

  it('says what each rule does', () => {
    expect(ruleDoes(rule({ expireAfterDays: 30, abortUploadsAfterDays: 7 }))).toBe('deleted after 30 days · unfinished uploads cleared after 7 days');
    expect(ruleDoes(rule({ expireAfterDays: 1, enabled: false }))).toBe('deleted after 1 day (paused)');
  });

  it('lifeSay: what ages out and what stays', () => {
    expect(lifeSay([])).toBe('Files stay until someone deletes them.');
    expect(lifeSay([rule({ prefix: 'tmp/', expireAfterDays: 7 }), rule({ abortUploadsAfterDays: 3 })])).toBe(
      'Files under tmp/ are deleted after 7 days. Everything else stays until someone deletes it. Unfinished uploads are cleared.',
    );
    expect(lifeSay([rule({ expireAfterDays: 365 })])).toBe('All files are deleted after 1 year.');
    expect(lifeSay([rule({ abortUploadsAfterDays: 7 })])).toBe('Files stay until someone deletes them. Unfinished uploads are cleared.');
    expect(lifeSay([rule({ prefix: 'tmp/', expireAfterDays: 7, enabled: false })])).toBe('Files stay until someone deletes them.');
  });
});

describe('lifecycleCode (golden)', () => {
  it('S3 JSON and the real AWS CLI call', () => {
    const [json, cli] = lifecycleCode({ bucket: 'media', endpoint: 'https://s3.northwind.dev', rules: [rule({ id: 'tmp', prefix: 'tmp/', expireAfterDays: 7 })] });
    expect(JSON.parse(json!.code)).toEqual({ Rules: [{ ID: 'tmp', Status: 'Enabled', Filter: { Prefix: 'tmp/' }, Expiration: { Days: 7 } }] });
    expect(cli!.code).toContain('aws s3api put-bucket-lifecycle-configuration --bucket media \\\n  --endpoint-url https://s3.northwind.dev');
  });

  it('no rules is the delete call', () => {
    const [, cli] = lifecycleCode({ bucket: 'media', endpoint: 'http://swarmy-garage:3900', rules: [] });
    expect(cli!.code).toContain('aws s3api delete-bucket-lifecycle --bucket media --endpoint-url http://swarmy-garage:3900');
  });
});
