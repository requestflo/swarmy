import { describe, expect, it } from 'bun:test';
import { envLayers, parseAppConfig } from '@swarmy/app-config';
import { sharedCell, sharedSentence } from './shared-vars-model';

const YAML = `version: 1
app: shop
env: { LOG_LEVEL: info, SESSION_SECRET: s3cr3t-value-here }
services:
  web: { image: ghcr.io/x/web:1, env: { LOG_LEVEL: warn } }
  api: { image: ghcr.io/x/api:1 }
environments:
  staging:
    branch: staging
    env: { LOG_LEVEL: debug }
    services: { api: { env: { SESSION_SECRET: other-secret-value } } }
`;
const layers = envLayers(parseAppConfig(YAML).config!, ['qa']);
const row = (k: string) => layers.rows.find((r) => r.key === k)!;

describe('shared variables view', () => {
  it('shows the shared value, coral where an environment overrides it, and who sets their own', () => {
    expect(sharedCell(row('LOG_LEVEL').envs.production)).toEqual({ text: 'info', override: false, masked: false, note: 'web sets its own' });
    expect(sharedCell(row('LOG_LEVEL').envs.staging)).toEqual({ text: 'debug', override: true, masked: false, note: 'web sets its own' });
    expect(sharedCell(row('LOG_LEVEL').envs.qa).override).toBe(false);
  });

  it('never shows a secret, not even an environment’s own override', () => {
    expect(sharedCell(row('SESSION_SECRET').envs.staging)).toEqual({ text: 'masked', override: true, masked: true, note: 'api: masked' });
  });

  it('says how many there are and who overrides what', () => {
    expect(sharedSentence(layers)).toBe('2 shared variables; staging overrides 2.');
    expect(sharedSentence({ environments: ['production'], rows: [] })).toBe('swarmy.yaml sets no shared variables yet.');
  });
});
