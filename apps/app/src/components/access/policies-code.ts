import { curl, hcl, tfNames, tfRef, tfResource, type Hcl } from '@/components/calm';
import type { PolicyRow } from './use-policy-editor';

/**
 * Code depth for access rules: the real calls — `/policies` in openapi.json
 * (needs `policy.write`, owners and admins by default) and Terraform's
 * `swarmy_policy`. Seeded defaults can only be switched on or off, so
 * Terraform imports them rather than creating them.
 */

function doc(source: string): Hcl {
  try {
    return JSON.parse(source) as Hcl;
  } catch {
    return source;
  }
}

/** The body PUT and POST take (`PolicyRequest`): the rule as the dashboard holds it. */
function body(r: PolicyRow) {
  return { name: r.name, ...(r.description ? { description: r.description } : {}), effect: r.effect, source: r.source, priority: r.priority, enabled: r.enabled };
}

export function policiesRest(rules: PolicyRow[]): string {
  const custom = rules.find((r) => !r.isDefault);
  const lines = ['# Every rule, with each one in plain words:', curl('GET', '/policies')];
  if (custom) {
    lines.push('', `# Change “${custom.name}” (the whole rule; the engine compiles it first`, '# and refuses a change that leaves no owner able to change rules):');
    lines.push(curl('PUT', `/policies/${custom.id}`, body(custom)));
  }
  return lines.join('\n');
}

export function policiesTerraform(rules: PolicyRow[]): string {
  const custom = rules.filter((r) => !r.isDefault);
  const defaults = rules.filter((r) => r.isDefault);
  const names = tfNames(
    [...custom, ...defaults].map((r) => r.name),
    'rule',
  );
  const blocks = custom.map((r, i) => {
    const d = doc(r.source);
    return tfResource('swarmy_policy', names[i] ?? 'rule', {
      name: r.name,
      description: r.description ?? undefined,
      effect: r.effect,
      priority: r.priority,
      enabled: r.enabled ? undefined : false,
      source: d !== null && typeof d === 'object' && !Array.isArray(d) ? tfRef(`jsonencode(${hcl(d, 1)})`) : r.source,
    });
  });
  const out: string[] = [];
  if (blocks.length > 0) {
    out.push(blocks.join('\n\n'), '', '# These exist already: import them rather than creating them twice.');
    out.push(...custom.map((r, i) => `#   terraform import swarmy_policy.${names[i] ?? 'rule'} ${r.id}`));
  } else {
    out.push('# No rules of your own yet. A swarmy_policy block adds one.');
  }
  if (defaults.length > 0) {
    out.push('', '# Seeded defaults can only be switched on or off. Import one to manage it:');
    out.push(...defaults.map((r, i) => `#   terraform import swarmy_policy.${names[custom.length + i] ?? 'rule'} ${r.id}`));
  }
  return out.join('\n');
}

