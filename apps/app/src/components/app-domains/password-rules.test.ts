import { describe, expect, test } from 'bun:test';
import { fromDraft, summarizeProtection, toDraft, type RouteProtection } from '@/components/ingress/protection-model';
import { isPasswordOn, passwordOff, passwordProblem, passwordSay, withPasswordUser, withoutPasswordUser } from './password-rules';
import { rulesOn, switchedOn } from './protection-rules';

const saved: RouteProtection = {
  ipAllow: [],
  ipDeny: [],
  blockBots: false,
  requiredHeaders: [],
  basicAuth: { users: [{ username: 'ops', passwordSecret: 'rpw_0d3a0d3a0d3a0d3a0d3a0d3a' }] },
};

describe('the password card', () => {
  test('switching it on with the first person carries the new password once, to the save', () => {
    const p = withPasswordUser(null, 'team', 'correct horse');
    expect(p?.basicAuth).toEqual({ users: [{ username: 'team', password: 'correct horse' }] });
    expect(isPasswordOn(p)).toBe(true);
  });

  test('a new password for someone already there replaces their saved one; others keep theirs', () => {
    const p = withPasswordUser(withPasswordUser(saved, 'dev', 'battery staple'), 'ops', 'new password');
    expect(p?.basicAuth?.users).toEqual([
      { username: 'dev', password: 'battery staple' },
      { username: 'ops', password: 'new password' },
    ]);
  });

  test('taking the last person off, or switching it off, turns the password off', () => {
    expect(withoutPasswordUser(saved, 'ops')).toBeNull();
    expect(passwordOff(saved)).toBeNull();
    const both = withPasswordUser(saved, 'dev', 'battery staple');
    expect(withoutPasswordUser(both, 'ops')?.basicAuth?.users.map((u) => u.username)).toEqual(['dev']);
  });

  test('other cards and the full form keep the password', () => {
    expect(switchedOn(saved, 'bots')?.basicAuth).toEqual(saved.basicAuth);
    expect(fromDraft(toDraft(saved))).toEqual(saved);
    expect(rulesOn(saved)).toBe(1);
    expect(summarizeProtection(saved)).toEqual(['password']);
  });

  test('says who can sign in, and why a password cannot be saved yet', () => {
    expect(passwordSay(null, 'grafana')).toBe('Anyone with the address reaches grafana.');
    expect(passwordSay(saved, 'grafana')).toBe('Visitors sign in as ops before they reach grafana.');
    const three = withPasswordUser(withPasswordUser(saved, 'dev', 'xxxxxxxx'), 'qa', 'xxxxxxxx');
    expect(passwordSay(three, 'grafana')).toBe('Visitors sign in as ops, dev or 1 more before they reach grafana.');
    expect(passwordProblem('my team', 'correct horse')).toBe('A username is letters, digits or . _ @ + -, with no spaces.');
    expect(passwordProblem('team', 'short')).toBe('Use at least 8 characters.');
    expect(passwordProblem('team', 'correct horse')).toBeNull();
  });
});
