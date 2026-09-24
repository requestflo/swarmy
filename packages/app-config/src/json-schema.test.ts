import { describe, expect, it } from 'bun:test';
import { z } from 'zod';
import { SWARMY_YAML_JSON_SCHEMA as S } from './json-schema';
import {
  AppConfigSchema,
  BucketSchema,
  CacheSchema,
  EnvironmentSchema,
  ResourceOverrideSchema,
  ServiceOverrideSchema,
  HealthcheckSchema,
  JobSchema,
  PostgresSchema,
  PreviewsSchema,
  ProtectSchema,
  SearchSchema,
  ServiceSchema,
  VectorSchema,
} from './schema';

/** Keys of a Zod object, unwrapping refinements. */
const zkeys = (t: z.ZodTypeAny): string[] => {
  let cur: z.ZodTypeAny = t;
  while (cur instanceof z.ZodEffects) cur = cur._def.schema;
  return Object.keys((cur as z.AnyZodObject).shape).sort();
};
const jkeys = (o: { properties: object }): string[] => Object.keys(o.properties).sort();

describe('JSON Schema ↔ Zod drift guard', () => {
  const service = S.properties.services.additionalProperties;
  const resources = S.properties.resources.additionalProperties.anyOf;

  it('top level, service, job and previews agree', () => {
    expect(jkeys(S)).toEqual(zkeys(AppConfigSchema));
    expect(jkeys(service)).toEqual(zkeys(ServiceSchema));
    expect(jkeys(S.properties.jobs.additionalProperties)).toEqual(zkeys(JobSchema));
    expect(jkeys(S.properties.previews)).toEqual(zkeys(PreviewsSchema));
    expect(jkeys(service.properties.healthcheck)).toEqual(zkeys(HealthcheckSchema));
    expect(jkeys(service.properties.domains.items.anyOf[1].properties.protect)).toEqual(
      zkeys(ProtectSchema),
    );
  });

  it('environments agree', () => {
    const e = S.properties.environments.additionalProperties;
    expect(jkeys(e)).toEqual(zkeys(EnvironmentSchema));
    expect(jkeys(e.properties.services.additionalProperties)).toEqual(zkeys(ServiceOverrideSchema));
    expect(jkeys(e.properties.resources.additionalProperties)).toEqual(
      zkeys(ResourceOverrideSchema),
    );
  });

  it('every resource type agrees', () => {
    type Obj = { properties: { type: { const: string } } };
    const byType: Record<string, Obj> = Object.fromEntries(
      (resources.slice(1) as unknown as Obj[]).map((r) => [r.properties.type.const, r]),
    );
    const at = (t: string): Obj => {
      const o = byType[t];
      if (!o) throw new Error(`no JSON Schema branch for ${t}`);
      return o;
    };
    expect(jkeys(at('postgres'))).toEqual(zkeys(PostgresSchema));
    expect(jkeys(at('cache'))).toEqual(zkeys(CacheSchema));
    expect(jkeys(at('search'))).toEqual(zkeys(SearchSchema));
    expect(jkeys(at('vector'))).toEqual(zkeys(VectorSchema));
    expect(jkeys(at('bucket'))).toEqual(zkeys(BucketSchema));
  });

  it('is serialisable as a plain JSON document', () => {
    expect(JSON.parse(JSON.stringify(S)).title).toBe('swarmy.yaml');
  });
});
