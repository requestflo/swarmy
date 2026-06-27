#!/usr/bin/env bun
/**
 * Regenerate the model/type definitions for all three swarmy SDKs from the
 * committed OpenAPI spec (`packages/api-rest/openapi.json`).
 *
 *   bun run scripts/gen-sdks.ts
 *
 * Only the GENERATED model files are overwritten:
 *   - sdks/typescript/src/models.ts
 *   - sdks/python/swarmy/models.py
 *   - sdks/go/models.go
 *
 * The hand-written client/transport/resource layers are never touched, so the
 * ergonomic API stays stable while models track the contract.
 *
 * The generator is intentionally tailored to the swarmy spec's small, flat
 * schema set (object schemas, primitive props, `nullable`, enums, arrays, and a
 * couple of inline nested objects). It is not a general OpenAPI generator.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');
const specPath = resolve(repoRoot, 'packages/api-rest/openapi.json');

interface JsonSchema {
  type?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  enum?: unknown[];
  nullable?: boolean;
  items?: JsonSchema;
  $ref?: string;
}

interface OpenApi {
  components: { schemas: Record<string, JsonSchema> };
}

const spec = JSON.parse(readFileSync(specPath, 'utf-8')) as OpenApi;
const schemas = spec.components.schemas;

/** Schemas emitted as nested types when referenced inline. */
const INLINE_OBJECT_NAMES: Record<string, string> = {
  // schemaName.propName -> generated nested type name
  'Service.replicas': 'ServiceReplicas',
  'CreateServiceRequest.env': 'EnvVar',
};

const isRequired = (schema: JsonSchema, prop: string): boolean =>
  (schema.required ?? []).includes(prop);

/** Resolve a local `$ref` (e.g. "#/components/schemas/Service") to its name. */
function refName(ref: string): string {
  return ref.split('/').pop() ?? ref;
}

// ----------------------------------------------------------------------------
// Naming helpers
// ----------------------------------------------------------------------------

function snakeToPascal(s: string): string {
  return s
    .split(/[_-]/)
    .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
    .join('');
}

/** Go acronym-aware field name from a snake_case JSON key. */
function goFieldName(key: string): string {
  const acronyms: Record<string, string> = {
    id: 'ID',
    os: 'OS',
    tls: 'TLS',
    url: 'URL',
  };
  return key
    .split('_')
    .map((p) => acronyms[p] ?? p.charAt(0).toUpperCase() + p.slice(1))
    .join('');
}

// ----------------------------------------------------------------------------
// TypeScript
// ----------------------------------------------------------------------------

function tsType(schema: JsonSchema): string {
  if (schema.$ref) return refName(schema.$ref);
  if (schema.enum) {
    if (schema.type === 'boolean') return schema.enum.map((v) => String(v)).join(' | ');
    return schema.enum.map((v) => `'${v}'`).join(' | ');
  }
  switch (schema.type) {
    case 'string':
      return 'string';
    case 'number':
    case 'integer':
      return 'number';
    case 'boolean':
      return 'boolean';
    case 'array':
      return `${tsType(schema.items!)}[]`;
    case 'object':
      return tsInlineObject(schema);
    default:
      return 'unknown';
  }
}

function tsInlineObject(schema: JsonSchema): string {
  const props = Object.entries(schema.properties ?? {}).map(([k, v]) => {
    const opt = isRequired(schema, k) ? '' : '?';
    return `${k}${opt}: ${tsType(v)}`;
  });
  return `{ ${props.join('; ')} }`;
}

function genTypeScript(): string {
  const lines: string[] = [];
  lines.push('/**');
  lines.push(' * GENERATED FILE — do not edit by hand.');
  lines.push(' *');
  lines.push(' * Regenerate with: `bun run scripts/gen-sdks.ts` from the repo root.');
  lines.push(' * Source of truth: packages/api-rest/openapi.json');
  lines.push(' */');
  lines.push('');

  for (const [name, schema] of Object.entries(schemas)) {
    if (schema.type !== 'object') continue;
    lines.push(`export interface ${name} {`);
    for (const [prop, propSchema] of Object.entries(schema.properties ?? {})) {
      const required = isRequired(schema, prop);
      let t = tsType(propSchema);
      if (propSchema.nullable) t += ' | null';
      const opt = required ? '' : '?';
      lines.push(`  ${prop}${opt}: ${t};`);
    }
    lines.push('}');
    lines.push('');
  }
  return lines.join('\n');
}

// ----------------------------------------------------------------------------
// Python
// ----------------------------------------------------------------------------

function pyType(schema: JsonSchema, nestedName?: string): string {
  if (schema.$ref) return refName(schema.$ref);
  if (schema.type === 'object' && nestedName) return nestedName;
  if (schema.enum && schema.type !== 'boolean') return 'str';
  switch (schema.type) {
    case 'string':
      return 'str';
    case 'number':
      return 'float';
    case 'integer':
      return 'int';
    case 'boolean':
      return 'bool';
    case 'array':
      return `List[${pyType(schema.items!)}]`;
    case 'object':
      return 'Dict[str, Any]';
    default:
      return 'Any';
  }
}

function genPython(): string {
  const lines: string[] = [];
  lines.push('"""GENERATED FILE - do not edit by hand.');
  lines.push('');
  lines.push('Regenerate with: ``bun run scripts/gen-sdks.ts`` from the repo root.');
  lines.push('Source of truth: packages/api-rest/openapi.json');
  lines.push('"""');
  lines.push('');
  lines.push('from __future__ import annotations');
  lines.push('');
  lines.push('from dataclasses import dataclass');
  lines.push('from typing import Any, Dict, List, Optional');
  lines.push('');

  // Collect inline nested object types to emit first.
  const nested = new Map<string, JsonSchema>();
  for (const [name, schema] of Object.entries(schemas)) {
    for (const [prop, propSchema] of Object.entries(schema.properties ?? {})) {
      const key = `${name}.${prop}`;
      if (propSchema.type === 'object' && INLINE_OBJECT_NAMES[key]) {
        nested.set(INLINE_OBJECT_NAMES[key], propSchema);
      }
      if (propSchema.type === 'array' && propSchema.items?.type === 'object' && INLINE_OBJECT_NAMES[key]) {
        nested.set(INLINE_OBJECT_NAMES[key], propSchema.items);
      }
    }
  }

  const emitClass = (name: string, schema: JsonSchema): void => {
    lines.push('');
    lines.push('@dataclass');
    lines.push(`class ${name}:`);
    const fields: { prop: string; type: string; required: boolean }[] = [];
    for (const [prop, propSchema] of Object.entries(schema.properties ?? {})) {
      const key = `${name}.${prop}`;
      const nestedName = INLINE_OBJECT_NAMES[key];
      let t = pyType(propSchema, nestedName);
      const required = isRequired(schema, prop);
      if (propSchema.nullable || !required) t = `Optional[${t}]`;
      fields.push({ prop, type: t, required });
    }
    // dataclass: required (no default) fields first, then defaulted ones.
    const ordered = [...fields].sort((a, b) => Number(b.required) - Number(a.required));
    for (const f of ordered) {
      lines.push(`    ${f.prop}: ${f.type}${f.required ? '' : ' = None'}`);
    }
    lines.push('');
    lines.push('    @classmethod');
    lines.push(`    def from_dict(cls, d: Dict[str, Any]) -> "${name}":`);
    lines.push('        return cls(');
    for (const [prop, propSchema] of Object.entries(schema.properties ?? {})) {
      const key = `${name}.${prop}`;
      const nestedName = INLINE_OBJECT_NAMES[key];
      if (nestedName && propSchema.type === 'object') {
        lines.push(`            ${prop}=${nestedName}.from_dict(d.get("${prop}") or {}),`);
      } else {
        lines.push(`            ${prop}=d.get("${prop}"),`);
      }
    }
    lines.push('        )');
    lines.push('');
  };

  // Nested object dataclasses first so they are defined before use.
  for (const [name, schema] of nested) emitClass(name, schema);

  // Top-level object schemas, excluding list envelopes and request bodies
  // (those map to method kwargs / tuples in the hand-written layer) — but we
  // still emit request body objects' nested types via `nested` above.
  const SKIP = new Set(
    Object.keys(schemas).filter(
      (n) => n.endsWith('List') || n.endsWith('Request'),
    ),
  );
  for (const [name, schema] of Object.entries(schemas)) {
    if (schema.type !== 'object') continue;
    if (SKIP.has(name)) continue;
    emitClass(name, schema);
  }
  return lines.join('\n').replace(/\n{3,}/g, '\n\n\n') + '\n';
}

// ----------------------------------------------------------------------------
// Go
// ----------------------------------------------------------------------------

function goType(schema: JsonSchema, nestedName: string | undefined, nullable: boolean): string {
  if (schema.$ref) return refName(schema.$ref);
  if (schema.type === 'object' && nestedName) return nestedName;
  let base: string;
  switch (schema.type) {
    case 'string':
      base = 'string';
      break;
    case 'number':
    case 'integer':
      base = 'int';
      break;
    case 'boolean':
      base = 'bool';
      break;
    case 'array':
      base = `[]${goType(schema.items!, undefined, false)}`;
      return base; // slices are nullable by nature
    case 'object':
      return 'map[string]any';
    default:
      base = 'any';
  }
  return nullable ? `*${base}` : base;
}

function genGo(): string {
  const lines: string[] = [];
  lines.push('// Code generated by scripts/gen-sdks.ts. DO NOT EDIT.');
  lines.push('//');
  lines.push('// Regenerate with: `bun run scripts/gen-sdks.ts` from the repo root.');
  lines.push('// Source of truth: packages/api-rest/openapi.json');
  lines.push('');
  lines.push('package swarmy');
  lines.push('');

  // Nested object types referenced inline (Service.replicas -> ServiceReplicas,
  // CreateServiceRequest.env -> []EnvVar).
  const nested = new Map<string, JsonSchema>();
  for (const [name, schema] of Object.entries(schemas)) {
    for (const [prop, propSchema] of Object.entries(schema.properties ?? {})) {
      const key = `${name}.${prop}`;
      if (propSchema.type === 'object' && INLINE_OBJECT_NAMES[key]) {
        nested.set(INLINE_OBJECT_NAMES[key], propSchema);
      }
      if (propSchema.type === 'array' && propSchema.items?.type === 'object' && INLINE_OBJECT_NAMES[key]) {
        nested.set(INLINE_OBJECT_NAMES[key], propSchema.items);
      }
    }
  }

  const emitStruct = (name: string, schema: JsonSchema): void => {
    lines.push(`type ${name} struct {`);
    for (const [prop, propSchema] of Object.entries(schema.properties ?? {})) {
      const key = `${name}.${prop}`;
      const required = isRequired(schema, prop);
      const nestedName = INLINE_OBJECT_NAMES[key];
      const goName = goFieldName(prop);
      let arrayItem: string | undefined;
      if (propSchema.type === 'array' && propSchema.items?.type === 'object' && nestedName) {
        arrayItem = `[]${nestedName}`;
      }
      const t = arrayItem ?? goType(propSchema, nestedName, !!propSchema.nullable);
      // omitempty for optional, non-nullable scalar request fields.
      const omit = !required && !propSchema.nullable ? ',omitempty' : '';
      lines.push(`\t${goName} ${t} \`json:"${prop}${omit}"\``);
    }
    lines.push('}');
    lines.push('');
  };

  for (const [name, schema] of nested) emitStruct(name, schema);
  for (const [name, schema] of Object.entries(schemas)) {
    if (schema.type !== 'object') continue;
    emitStruct(name, schema);
  }
  return lines.join('\n');
}

// ----------------------------------------------------------------------------
// Write outputs + gofmt
// ----------------------------------------------------------------------------

const tsOut = resolve(repoRoot, 'sdks/typescript/src/models.ts');
const pyOut = resolve(repoRoot, 'sdks/python/swarmy/models.py');
const goOut = resolve(repoRoot, 'sdks/go/models.go');

writeFileSync(tsOut, genTypeScript());
writeFileSync(pyOut, genPython());
writeFileSync(goOut, genGo());

// Best-effort gofmt so the generated Go matches the hand-written style.
try {
  const { spawnSync } = await import('node:child_process');
  const r = spawnSync('gofmt', ['-w', goOut], { encoding: 'utf-8' });
  if (r.status !== 0 && r.stderr) console.warn(`gofmt: ${r.stderr}`);
} catch {
  // gofmt not available; the file is still syntactically valid.
}

console.log('Regenerated SDK models:');
console.log(`  ${tsOut}`);
console.log(`  ${pyOut}`);
console.log(`  ${goOut}`);
