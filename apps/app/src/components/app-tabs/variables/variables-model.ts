import { looksSecret, type InvService, type SecretFamilyView } from '@swarmy/core';
import { toYaml, withHeader, type CodeTab } from '@/components/calm';
import { shortName } from '../use-stack-services';

/** Where a variable comes from: you set it, swarmy injects it, or it points at a resource. */
export type VarOrigin = 'you' | 'swarmy' | 'binding';

export interface VarRow {
  key: string;
  /** The value when every service agrees; null when it differs by service. */
  value: string | null;
  services: string[];
  origin: VarOrigin;
  /** A plain variable whose name or value looks like a password. */
  secretLooking: boolean;
}

const INJECTED = /^(OTEL_|SENTRY_|SWARMY_)/;

function splitEnv(line: string): [string, string] {
  const i = line.indexOf('=');
  return i < 0 ? [line, ''] : [line.slice(0, i), line.slice(i + 1)];
}

/** Fold every service's env into one row per key (the app's view, not the service's). */
export function collectVariables(stack: string, services: InvService[]): VarRow[] {
  const byKey = new Map<string, { values: Set<string>; services: string[] }>();
  for (const s of services) {
    for (const line of s.env) {
      const [key, value] = splitEnv(line);
      if (!key) continue;
      const row = byKey.get(key) ?? { values: new Set<string>(), services: [] };
      row.values.add(value);
      row.services.push(shortName(stack, s.name));
      byKey.set(key, row);
    }
  }
  return [...byKey.entries()]
    .map(([key, r]) => {
      const value = r.values.size === 1 ? [...r.values][0]! : null;
      const origin: VarOrigin = INJECTED.test(key) ? 'swarmy' : value?.includes('${{') ? 'binding' : 'you';
      return {
        key,
        value,
        services: r.services.sort(),
        origin,
        secretLooking: origin === 'you' && [...r.values].some((v) => looksSecret(key, v)),
      };
    })
    .sort((a, b) => ORDER[a.origin] - ORDER[b.origin] || a.key.localeCompare(b.key));
}

const ORDER: Record<VarOrigin, number> = { binding: 0, you: 1, swarmy: 2 };

/** The env + secrets part of swarmy.yaml for what is on screen. Secret values never appear. */
export function variablesCode(stack: string, services: InvService[], families: SecretFamilyView[]): CodeTab[] {
  const svc: Record<string, { env?: Record<string, string>; secrets?: string[] }> = {};
  for (const s of services) {
    const name = shortName(stack, s.name);
    const env: Record<string, string> = {};
    for (const line of s.env) {
      const [k, v] = splitEnv(line);
      if (!k || INJECTED.test(k)) continue;
      env[k] = looksSecret(k, v) ? '<set in the dashboard — move it to a secret>' : v;
    }
    const secrets = families.filter((f) => f.consumers.some((c) => c.serviceId === s.id)).map((f) => f.family);
    svc[name] = { ...(Object.keys(env).length ? { env } : {}), ...(secrets.length ? { secrets } : {}) };
  }
  const yaml = withHeader(
    `swarmy.yaml (${stack}) — names and wiring only; secret values are never written here`,
    toYaml({ services: svc }),
  );
  const first = services[0] ? shortName(stack, services[0].name) : 'web';
  const cli = [
    `# list what ${first} runs with (secrets show as names only)`,
    `swarmy env ls --app ${stack} --service ${first}`,
    '',
    '# write it to .env (secret values need a secrets.read key)',
    `swarmy env pull --app ${stack} --service ${first}`,
    '',
    '# push .env back; mark the ones that are secrets',
    `swarmy env push --app ${stack} --service ${first} --secret STRIPE_SECRET_KEY`,
  ].join('\n');
  return [
    { label: 'swarmy.yaml', code: yaml },
    { label: 'CLI', code: cli },
  ];
}
