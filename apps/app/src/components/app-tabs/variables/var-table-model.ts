import type { InvService, SecretFamilyView, ServiceSecretVarView } from '@swarmy/core';
import { shortName } from '../use-stack-services';
import { collectVariables, type VarOrigin } from './variables-model';

/**
 * One table for everything the app runs with (board AppVariables): plain
 * values, connections, swarmy's own, per-service secret variables (revealable,
 * audited) and secret families (write-only, rotated). PURE — unit-tested.
 */
export type TableKind = VarOrigin | 'secretVar' | 'family';

export interface TableRow {
  key: string;
  kind: TableKind;
  /** Plain value when every service in scope agrees; null when it differs. */
  value: string | null;
  /** Short service names in scope that use it. */
  services: string[];
  /** A plain value whose name or value looks like a password. */
  secretLooking: boolean;
  /** Secret variable: the services that mount it (reveal reads from the first). */
  targets?: { id: string; name: string; view: ServiceSecretVarView }[];
  family?: SecretFamilyView;
}

/** Plumbing the secret-var shim writes into env — not settings a person set. */
function plumbing(key: string, vars: readonly ServiceSecretVarView[]): boolean {
  return key === 'SWARMY_SECRET_ENV' || vars.some((v) => v.delivery === 'file' && key === `${v.key}_FILE`);
}

const ORDER: Record<TableKind, number> = { binding: 0, you: 1, secretVar: 2, family: 3, swarmy: 4 };

export function buildTableRows(
  stack: string,
  services: readonly InvService[],
  vars: Readonly<Record<string, ServiceSecretVarView[] | undefined>>,
  families: readonly SecretFamilyView[],
): TableRow[] {
  const allVars = services.flatMap((s) => vars[s.id] ?? []);
  const plain: TableRow[] = collectVariables(stack, [...services])
    .filter((r) => !plumbing(r.key, allVars))
    .map((r) => ({ key: r.key, kind: r.origin, value: r.value, services: r.services, secretLooking: r.secretLooking }));

  const byKey = new Map<string, TableRow>();
  for (const s of services) {
    for (const view of vars[s.id] ?? []) {
      const name = shortName(stack, s.name);
      const row = byKey.get(view.key) ?? { key: view.key, kind: 'secretVar', value: null, services: [], secretLooking: false, targets: [] };
      row.services.push(name);
      row.targets!.push({ id: s.id, name, view });
      byKey.set(view.key, row);
    }
  }

  const ids = new Set(services.map((s) => s.id));
  const fams: TableRow[] = families.map((f) => ({
    key: f.family,
    kind: 'family',
    value: null,
    services: f.consumers.filter((c) => ids.has(c.serviceId)).map((c) => shortName(stack, c.serviceName)).sort(),
    secretLooking: false,
    family: f,
  }));
  return [...plain, ...byKey.values(), ...fams].sort((a, b) => ORDER[a.kind] - ORDER[b.kind] || a.key.localeCompare(b.key));
}

/** The .env view: read only, secrets stay masked (their names and where they live, never a value). */
export function envText(rows: readonly TableRow[], scope: string): string {
  const head = `# .env · ${scope} — read only, secrets stay masked`;
  const lines = rows.map((r) => {
    if (r.kind === 'family') return `# ${r.key} is a secret · mounted at /run/secrets/${r.key}`;
    if (r.kind === 'secretVar') return `${r.key}=•••••• # secret · v${r.targets?.[0]?.view.version ?? 1}`;
    if (r.value === null) return `# ${r.key} differs by service — pick one service to see it`;
    return `${r.key}=${r.secretLooking ? '••••••' : r.value}`;
  });
  return [head, ...lines].join('\n');
}

/**
 * Rows for one scope chip: every service (`null`) or one service — then values
 * are that service's own and only the secrets it reads are listed.
 */
export function rowsFor(
  stack: string,
  services: readonly InvService[],
  vars: Readonly<Record<string, ServiceSecretVarView[] | undefined>>,
  families: readonly SecretFamilyView[],
  scopeId: string | null,
): TableRow[] {
  const one = scopeId ? services.filter((s) => s.id === scopeId) : null;
  const rows = buildTableRows(stack, one ?? services, vars, families);
  return one ? rows.filter((r) => r.kind !== 'family' || r.services.length > 0) : rows;
}
