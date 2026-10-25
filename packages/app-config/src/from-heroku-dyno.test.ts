import { describe, expect, it } from 'bun:test';
import { parseAppConfig } from './parse';
import { DYNO_SIZES, dynoLimitsText, dynoSize } from './from-heroku-dyno';

describe('dyno sizes → swarmy resource limits (the documented table)', () => {
  it('shared dynos take the preset with the same memory', () => {
    expect(['eco', 'basic', 'standard-1x', 'hobby'].map(dynoSize)).toEqual(Array(4).fill({ size: 'small' }));
    expect(['standard-2x', 'Standard-2X', 'private-s', 'shield-s'].map(dynoSize)).toEqual(Array(4).fill({ size: 'medium' }));
  });

  it('dedicated dynos keep their memory and vCPUs', () => {
    expect(dynoSize('Performance-M')).toEqual({ memory: '2560mb', cpu: 2 });
    expect(dynoSize('performance-l')).toEqual({ memory: '14gb', cpu: 8 });
    expect(dynoSize('private-l-ram')).toEqual({ memory: '30gb', cpu: 4 });
    expect(dynoSize('shield-xl')).toEqual({ memory: '62gb', cpu: 8 });
    expect(dynoSize('performance-2xl')).toEqual({ memory: '126gb', cpu: 16 });
    expect(dynoSize('quantum-9x')).toBeNull();
  });

  it('says the limits the way swarmy.yaml spells them', () => {
    expect(dynoLimitsText({ size: 'medium' })).toBe('size: medium');
    expect(dynoLimitsText({ memory: '14gb', cpu: 8 })).toBe('memory: 14gb, cpu: 8');
  });

  it('every row is a service swarmy.yaml accepts', () => {
    for (const size of Object.keys(DYNO_SIZES)) {
      const keys = dynoLimitsText(dynoSize(size)!).split(', ').map((kv) => `    ${kv}`);
      const yaml = ['version: 1', 'app: a', 'services:', '  web:', '    image: nginx:1.27', ...keys, ''].join('\n');
      expect(parseAppConfig(yaml).issues.filter((i) => i.severity === 'error')).toEqual([]);
    }
  });
});
