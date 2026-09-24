import {
  extractBindings,
  parseAppConfig,
  toDesired,
  type ConfigIssue,
  type DesiredApp,
} from '@swarmy/app-config';
import type { BlueprintManaged, BlueprintMetaView } from '@swarmy/core';
import {
  MANAGED_CACHE_OVERHEAD_MB,
  MANAGED_POSTGRES_MB,
  ONE_GB_NODE_BUDGET_MB,
  type AppTemplate,
} from './types';

export interface TemplateRenderParams {
  /** Stack name (becomes `app:`). */
  stack: string;
  /** Wizard option values; missing keys take the option's default. */
  options?: Record<string, string | boolean>;
}

export interface LoadedTemplate {
  /** The substituted swarmy.yaml text that was parsed. */
  yaml: string;
  desired?: DesiredApp;
  issues: ConfigIssue[];
}

const OPT_RE = /\[\[opt\.([A-Za-z0-9_]+)\]\]/g;

/** Option value with the declared default; booleans render as `true`/`false`. */
function optionValue(t: AppTemplate, key: string, given: Record<string, string | boolean>): string {
  const v = given[key];
  if (typeof v === 'boolean') return String(v);
  if (typeof v === 'string' && v.trim()) return v.trim();
  const def = t.options?.find((o) => o.key === key)?.defaultValue;
  return def === undefined ? '' : String(def);
}

/**
 * Substitute params into the template yaml: `app:` ← stack, `[[opt.k]]` ← the
 * option value, JSON-escaped so it is safe inside a double-quoted YAML scalar
 * (templates always quote option placeholders).
 */
export function renderTemplateYaml(t: AppTemplate, params: TemplateRenderParams): string {
  const given = params.options ?? {};
  return t.yaml
    .replace(/^app:.*$/m, `app: ${params.stack}`)
    .replace(OPT_RE, (_m, key: string) => JSON.stringify(optionValue(t, key, given)).slice(1, -1));
}

/** Parse + validate + normalise a template for a stack. */
export function loadTemplate(t: AppTemplate, params: TemplateRenderParams): LoadedTemplate {
  const yaml = renderTemplateYaml(t, params);
  const parsed = parseAppConfig(yaml);
  if (!parsed.config) return { yaml, issues: parsed.issues };
  return { yaml, desired: toDesired(parsed.config), issues: parsed.issues };
}

/** The service that gets the URL: `primary`, else the only service with a port. */
export function primaryService(t: AppTemplate, desired: DesiredApp): { name: string; port: number } | null {
  const withPort = desired.services.filter((s) => s.port !== undefined);
  const pick = t.primary
    ? desired.services.find((s) => s.name === t.primary)
    : withPort.length === 1
      ? withPort[0]
      : undefined;
  return pick?.port !== undefined ? { name: pick.name, port: pick.port } : null;
}

/** Every `secrets.<name>` a template references (bindings or file mounts). */
export function referencedSecrets(desired: DesiredApp): Set<string> {
  const out = new Set<string>();
  for (const s of desired.services) {
    for (const name of s.secrets) out.add(name);
    for (const v of Object.values(s.env)) {
      for (const b of extractBindings(v)) if (b.ref?.ns === 'secret') out.add(b.ref.name);
    }
  }
  return out;
}

/** Memory at size `s` (no read replicas): services + managed data. */
export function estimateMemoryMb(desired: DesiredApp): number {
  let mb = 0;
  for (const s of desired.services) mb += (s.memoryMb ?? 256) * Math.max(1, s.replicas);
  for (const r of desired.resources) {
    if (r.type === 'postgres') mb += MANAGED_POSTGRES_MB;
    if (r.type === 'cache') mb += r.memoryMb + MANAGED_CACHE_OVERHEAD_MB;
  }
  return mb;
}

const MANAGED_LABEL: Record<BlueprintManaged, string> = {
  postgres: 'Postgres',
  cache: 'Cache',
  bucket: 'Bucket',
  search: 'Search',
};

/** Gallery metadata, derived from the template + its normalised yaml. */
export function templateMeta(t: AppTemplate): BlueprintMetaView {
  const loaded = loadTemplate(t, { stack: 'demo' });
  const desired = loaded.desired;
  if (!desired) {
    throw new Error(
      `template "${t.id}" does not parse: ${loaded.issues.map((i) => i.message).join('; ')}`,
    );
  }
  const managed: BlueprintManaged[] = [];
  for (const r of desired.resources) {
    if (r.type === 'postgres' && !managed.includes('postgres')) managed.push('postgres');
    if (r.type === 'cache' && !managed.includes('cache')) managed.push('cache');
    if (r.type === 'bucket' && !managed.includes('bucket')) managed.push('bucket');
    if (r.type === 'search' && !managed.includes('search')) managed.push('search');
  }
  const primary = primaryService(t, desired);
  const minMemoryMb = estimateMemoryMb(desired);
  const heavy = minMemoryMb > ONE_GB_NODE_BUDGET_MB || t.heavyReason !== undefined;
  const hasVolume = desired.services.some((s) => s.volumes.length > 0);
  const hasSecret = Object.keys(t.generate ?? {}).length > 0;
  const resources = [
    ...managed.map((m) => MANAGED_LABEL[m]),
    ...(hasSecret ? ['Secret'] : []),
    ...(hasVolume ? ['Volume'] : []),
    desired.services.length > 1 ? `${desired.services.length} services` : 'App',
    ...(primary && t.exposure !== 'private' ? ['Route'] : []),
    ...(t.exposure === 'private' ? ['Private'] : []),
  ];
  return {
    id: t.id,
    name: t.name,
    tagline: t.tagline,
    category: t.category,
    resources,
    docOnly: false,
    supportsDomain: primary !== null && t.exposure !== 'private',
    options: t.options ?? [],
    icon: t.icon,
    website: t.website,
    version: t.version,
    minMemoryMb,
    heavy,
    ...(heavy
      ? {
          heavyReason:
            t.heavyReason ?? `Needs about ${minMemoryMb} MB, more than a 1 GB server has spare`,
        }
      : {}),
    managed,
    services: desired.services.map((s) => s.name),
    ...(primary ? { httpPort: primary.port } : {}),
    postDeploy: t.postDeploy,
    source: t.source ? 'coolify' : 'curated',
    ...(t.source
      ? {
          attribution: `Adapted from Coolify's ${t.source.path} (Apache-2.0, © Coolify contributors)`,
        }
      : {}),
  };
}
