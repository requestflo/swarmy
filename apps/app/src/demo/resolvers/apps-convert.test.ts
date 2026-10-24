import { describe, expect, it } from 'bun:test';
import { composeToAppConfig, parseAppConfig } from '@swarmy/app-config';
import { DEMO_CONVERSIONS } from './apps-convert';
import { dataCompose, platformCompose } from './releases';

/** The newest release compose of each demo app the Source tab can convert. */
const NEWEST: Record<string, string> = {
  data: dataCompose('2.4.0', 3),
  platform: platformCompose('0.42.1', true),
};

describe('demo apps.convertToConfig', () => {
  for (const [stack, compose] of Object.entries(NEWEST)) {
    it(`${stack}: is exactly what composeToAppConfig writes, and parses clean`, () => {
      const real = composeToAppConfig(compose, { app: stack });
      const demo = DEMO_CONVERSIONS[stack]!;
      expect(demo.yaml).toBe(real.yaml!);
      expect(demo.changes).toEqual(real.changes);
      expect(demo.untranslated).toEqual(real.untranslated);
      expect(parseAppConfig(demo.yaml).issues).toEqual([]);
    });
  }
});
