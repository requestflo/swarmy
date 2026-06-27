/**
 * Emit the committed OpenAPI spec artifact (`packages/api-rest/openapi.json`).
 *
 *   bun run --filter @swarmy/api-rest openapi:dump
 *
 * The spec is generated from the same Zod route definitions used at runtime, so
 * it cannot drift from validation. The committed file is the contract: SDK /
 * Terraform-provider codegen consume it, and a CI diff test (TODO) can fail when
 * the generated spec drifts from the committed one. The dump uses a stub
 * `resolveContextFromApiKey` because spec assembly never executes handlers.
 */
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { buildOpenApiDocument } from '../app';

const here = dirname(fileURLToPath(import.meta.url));
const out = resolve(here, '../../openapi.json');

const doc = buildOpenApiDocument({
  resolveContextFromApiKey: async () => null,
});

writeFileSync(out, `${JSON.stringify(doc, null, 2)}\n`);
// eslint-disable-next-line no-console
console.log(`wrote ${out}`);
