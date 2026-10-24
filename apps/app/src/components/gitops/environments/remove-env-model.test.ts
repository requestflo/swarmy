import { describe, expect, it } from 'bun:test';
import type { AppEnvironment } from '../gitops-types';
import { removedWords, removeEnvSteps } from './remove-env-model';

const qa = (slots: string[] = ['stripe-key']): AppEnvironment => ({
  environment: 'qa', branch: 'qa', stack: 'shop-qa', latest: null, keptVolumes: [],
  dashboard: { from: 'production', secretSlots: slots.map((f) => ({ family: f, envFamily: `${f}.qa`, consumers: [{ service: 'api' }], filled: true })) },
});

describe('remove environment model', () => {
  it('says what goes and what stays, keep by default', () => {
    const keep = removeEnvSteps(qa(), 'keep');
    expect(keep.map(([t]) => t)).toEqual([
      'QA’s services stop and go',
      'Its database stays, with its backups',
      'Its own secret is deleted',
      'Pushes to qa stop deploying it',
    ]);
    expect(keep[2]![1]).toBe('stripe-key.qa · shared secrets aren’t touched');
    expect(removeEnvSteps(qa(), 'delete')[1]![0]).toBe('Its database is deleted, with everything in it');
    expect(removeEnvSteps(qa(['a', 'b']), 'keep')[2]![0]).toBe('Its own secrets are deleted');
    expect(removeEnvSteps(qa([]), 'keep')[2]![0]).toBe('No secrets of its own to delete');
  });

  it('the receipt names what was kept', () => {
    const base = { environment: 'qa', secrets: { removed: ['stripe-key.qa'], kept: [] } };
    expect(removedWords({ ...base, databases: { kept: ['db'], deleted: [] } })).toBe('QA is gone. Its database keeps running — remove it from Data when you’re done.');
    expect(removedWords({ ...base, databases: { kept: [], deleted: ['db'] } })).toBe('QA is gone. Its database is deleted.');
    expect(removedWords({ environment: 'qa', databases: { kept: [], deleted: [] }, secrets: { removed: [], kept: ['x.qa'] } })).toBe(
      'QA is gone. x.qa stays: another app still reads it.',
    );
  });
});
