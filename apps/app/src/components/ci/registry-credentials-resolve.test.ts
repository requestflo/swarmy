import { describe, expect, test } from 'bun:test';
import { resolutionSentence, resolveImageLogin } from './registry-credentials-resolve';

const creds = [
  { id: 'ghcr', prefix: 'ghcr.io', username: 'me' },
  { id: 'ghcr-nw', prefix: 'ghcr.io/northwind', username: 'northwind-ci' },
  { id: 'hub', prefix: 'docker.io', username: 'northwindbot' },
];
const BUILTIN = 'localhost:5000';

describe('resolveImageLogin', () => {
  test('empty input resolves to nothing', () => {
    expect(resolveImageLogin('  ', creds, BUILTIN)).toBeNull();
  });
  test('the longer prefix wins, and names the one it beat', () => {
    const r = resolveImageLogin('ghcr.io/northwind/api:v118', creds, BUILTIN);
    expect(r?.kind === 'login' && [r.cred.id, r.beats?.id]).toEqual(['ghcr-nw', 'ghcr']);
    expect(r && resolutionSentence(r)).toBe(
      'Uses ghcr.io/northwind (northwind-ci) — it beats ghcr.io because the longer prefix wins.',
    );
  });
  test('Docker Hub shorthand resolves to docker.io/library', () => {
    const r = resolveImageLogin('postgres:16', creds, BUILTIN);
    expect(r?.ref).toBe('docker.io/library/postgres:16');
    expect(r && resolutionSentence(r)).toContain('the only prefix that matches. Authenticated pulls');
  });
  test('the in-swarm registry needs no saved login', () => {
    const r = resolveImageLogin('localhost:5000/storefront/web@sha256:abc', creds, BUILTIN);
    expect(r).toEqual({ kind: 'builtin', ref: 'localhost:5000/storefront/web@sha256:abc', host: BUILTIN });
  });
  test('segment-exact: ghcr.io/northwindx is not ghcr.io/northwind', () => {
    const r = resolveImageLogin('ghcr.io/northwindx/app', creds, BUILTIN);
    expect(r?.kind === 'login' && r.cred.id).toBe('ghcr');
  });
  test('no match is a public pull', () => {
    const r = resolveImageLogin('quay.io/coreos/etcd:v3', creds, null);
    expect(r && resolutionSentence(r)).toBe('No saved login matches quay.io — the image has to be public to pull.');
  });
});
