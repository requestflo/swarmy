/**
 * Convert a docker-compose file into a starter swarmy.yaml (the "Convert
 * compose → swarmy.yaml" step of the New app wizard and of a compose app's
 * Source tab, epic-git-apps phase 5).
 *
 * Pure: compose text in, swarmy.yaml text out, with what changed shape on the
 * way (`changes`) and what didn't make it, each with why (`untranslated`). It
 * is a STARTER, not a lossless translation, and the result always parses with
 * {@link parseAppConfig}.
 *
 *  - Recognisable data services become managed resources: postgres/postgis →
 *    `postgres`, redis/valkey/keydb → `cache`, meilisearch/typesense →
 *    `search`, qdrant → `vector`, minio → `bucket`.
 *  - Env vars that point at one of those services become bindings
 *    (`${{ db.url }}`); literal credentials become `${{ secrets.<name> }}`.
 *  - Everything else is a service: `build:` or `image:`, the first container
 *    port, `command`, `environment`, `deploy.replicas`, named volumes.
 */
import { parse as parseYaml, stringify } from 'yaml';
import { DEFAULT_POSTGRES_VERSION, POSTGRES_VERSIONS, UNIT_NAME_RE } from './schema';
import { parseAppConfig } from './parse';
import { envFor, type ResourceHosts, type ResourceKind } from './from-compose-env';
import { gapSentence, keyGaps, portGaps, resourceGaps, volumeGap, type ComposeGap } from './from-compose-gaps';
import { appName, commandOf, envOf, firstPort, imageMajor, sourceOf, unitName, volumesOf, type ComposeService } from './from-compose-read';

export type { ComposeGap } from './from-compose-gaps';

export interface ComposeConversion {
  /** The swarmy.yaml text, or null when the compose file couldn't be read. */
  yaml: string | null;
  /** Everything worth saying, in plain words, in order: the changes and the gaps. */
  notes: string[];
  /** What changed shape on the way (a database became a managed resource, a URL a binding). */
  changes: string[];
  /** What didn't make it into the file, each with why (also in `notes`). */
  untranslated: ComposeGap[];
}

const RESOURCE_IMAGES: Array<[RegExp, ResourceKind, Record<string, unknown>?]> = [
  [/(^|\/)(postgres|postgis\/postgis|pgvector\/pgvector)(:|$)/, 'postgres'],
  [/(^|\/)(redis|valkey\/valkey|valkey|eqalpha\/keydb|keydb)(:|$)/, 'cache'],
  [/(^|\/)(getmeili\/meilisearch|meilisearch)(:|$)/, 'search', { engine: 'meilisearch' }],
  [/(^|\/)(typesense\/typesense)(:|$)/, 'search', { engine: 'typesense' }],
  [/(^|\/)(qdrant\/qdrant)(:|$)/, 'vector', { engine: 'qdrant' }],
  [/(^|\/)(minio\/minio|bitnami\/minio)(:|$)/, 'bucket'],
];

function collector() {
  const c: ComposeConversion = { yaml: null, notes: [], changes: [], untranslated: [] };
  return {
    c,
    change: (...xs: string[]): void => {
      c.notes.push(...xs);
      c.changes.push(...xs);
    },
    gap: (...gs: ComposeGap[]): void => {
      c.untranslated.push(...gs);
      c.notes.push(...gs.map(gapSentence));
    },
    fail: (note: string): ComposeConversion => ({ ...c, notes: [...c.notes, note] }),
  };
}

/** Convert compose YAML text into a starter swarmy.yaml. */
export function composeToAppConfig(composeText: string, opts: { app?: string } = {}): ComposeConversion {
  const k = collector();
  let doc: unknown;
  try {
    doc = parseYaml(composeText);
  } catch (e) {
    return k.fail(`The compose file isn't valid YAML (${e instanceof Error ? e.message : String(e)}).`);
  }
  const services = (doc as { services?: unknown } | null)?.services;
  if (!services || typeof services !== 'object' || Object.keys(services).length === 0) return k.fail('The compose file has no services.');

  const taken = new Set<string>();
  // Pass 1: which compose services are managed resources?
  const resources: Record<string, Record<string, unknown> | ResourceKind> = {};
  const hosts: ResourceHosts = new Map();
  const appServices: Array<[string, ComposeService]> = [];
  for (const [rawName, rawSvc] of Object.entries(services as Record<string, unknown>)) {
    const svc = (rawSvc ?? {}) as ComposeService;
    const image = typeof svc.image === 'string' ? svc.image : '';
    const match = svc.build === undefined ? RESOURCE_IMAGES.find(([re]) => re.test(image)) : undefined;
    if (!match) {
      appServices.push([rawName, svc]);
      continue;
    }
    const [, kind, extra] = match;
    const name = unitName(rawName, taken);
    const spec: Record<string, unknown> = { ...extra };
    const major = kind === 'postgres' ? imageMajor(image) : undefined;
    if (major !== undefined && major !== DEFAULT_POSTGRES_VERSION) {
      if ((POSTGRES_VERSIONS as readonly number[]).includes(major)) spec.version = major;
      else k.gap({ service: rawName, key: `image: ${image}`, reason: `swarmy runs Postgres ${POSTGRES_VERSIONS.join(', ')}, so it starts on ${DEFAULT_POSTGRES_VERSION}: upgrade the data when you restore it` });
    }
    resources[name] = Object.keys(spec).length ? { type: kind, ...spec } : kind;
    hosts.set(rawName, { name, kind });
    if (typeof svc.container_name === 'string') hosts.set(svc.container_name, { name, kind });
    k.change(`${rawName} (${image}) becomes a managed ${kind} resource "${name}" — swarmy runs, backs up and wires it.`);
    k.gap(...resourceGaps(rawName, svc, kind, name));
  }
  if (appServices.length === 0) return k.fail('Every service is a database or cache — there is no app service to deploy.');

  // Pass 2: app services.
  const out: Record<string, Record<string, unknown>> = {};
  for (const [rawName, svc] of appServices) {
    const s = sourceOf(svc);
    if (!s) {
      k.gap({ service: rawName, key: 'the whole service', reason: 'it has neither build: nor image:, so there is nothing to run' });
      continue;
    }
    if (s.build && typeof svc.image === 'string') k.gap({ service: rawName, key: `image: ${svc.image}`, reason: 'it keeps build:, and swarmy tags its own builds' });
    const name = unitName(rawName, taken);
    const command = commandOf(svc.command);
    if (command) s.command = command;
    const port = firstPort(svc);
    if (port) s.port = port;
    const replicas = (svc.deploy as { replicas?: unknown } | undefined)?.replicas;
    if (typeof replicas === 'number' && Number.isInteger(replicas) && replicas >= 0 && replicas <= 100) s.replicas = replicas;

    const env = envFor(rawName, envOf(svc.environment), hosts);
    k.change(...env.changes);
    k.gap(...env.gaps);
    if (Object.keys(env.env).length) s.env = env.env;

    const vols: Record<string, string> = {};
    for (const v of volumesOf(svc.volumes)) {
      const gap = volumeGap(rawName, v);
      const vname = (v.source ?? '').toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30);
      if (gap) k.gap(gap);
      else if (UNIT_NAME_RE.test(vname)) vols[vname] = v.target;
      else k.gap({ service: rawName, key: `volumes: ${v.raw}`, reason: `"${v.source}" can't be a swarmy volume name; give it a lowercase name under volumes: in the file` });
    }
    if (Object.keys(vols).length) s.volumes = vols;
    k.gap(...portGaps(rawName, svc, port), ...keyGaps(rawName, svc));
    out[name] = s;
  }
  if (Object.keys(out).length === 0) return k.c;

  const config: Record<string, unknown> = {
    version: 1,
    app: appName(opts.app ?? 'my-app'),
    services: out,
    ...(Object.keys(resources).length ? { resources } : {}),
  };
  const yaml = `# Converted from docker-compose by swarmy — review before you commit it.\n${stringify(config, { lineWidth: 0 })}`;
  const notes = [...k.c.notes];
  for (const issue of parseAppConfig(yaml).issues) {
    if (issue.severity === 'error') notes.push(`Needs a fix before it deploys: ${issue.message}`);
  }
  return { ...k.c, yaml, notes };
}
