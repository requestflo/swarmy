import type { DomainRoute, IngressConfig } from '../types';

/** Build a Caddyfile from an org ingress config. Pure string construction. */
export function buildCaddyfile(config: IngressConfig): string {
  const out: string[] = [];
  const extra = config.globalOptions.extraConfig as Record<string, unknown>;

  const global: string[] = [];
  if (config.globalOptions.email) global.push(`  email ${config.globalOptions.email}`);
  if (config.globalOptions.onDemandTls) {
    global.push('  on_demand_tls {');
    if (typeof extra.onDemandAsk === 'string') global.push(`    ask ${extra.onDemandAsk}`);
    global.push('  }');
  }
  if (global.length) {
    out.push('{', ...global, '}', '');
  }

  for (const route of config.domains) {
    out.push(...buildSite(route, config), '');
  }
  return `${out.join('\n').trimEnd()}\n`;
}

function buildSite(r: DomainRoute, config: IngressConfig): string[] {
  const address = r.tls === 'off' ? `http://${r.domain}` : r.domain;
  const out: string[] = [`${address} {`];

  if (r.tls === 'custom') {
    const certs = (config.globalOptions.extraConfig as Record<string, unknown>).certs as
      | Record<string, { cert: string; key: string }>
      | undefined;
    const material = certs?.[r.domain];
    if (material) out.push(`  tls ${material.cert} ${material.key}`);
  } else if (config.globalOptions.onDemandTls && r.tls === 'auto') {
    out.push('  tls {', '    on_demand', '  }');
  }

  const upstream = `${r.service}:${r.port}`;
  if (r.pathPrefix && r.pathPrefix !== '/') {
    const directive = r.stripPathPrefix ? 'handle_path' : 'handle';
    out.push(`  ${directive} ${r.pathPrefix}* {`, `    reverse_proxy ${upstream}`, '  }');
  } else {
    out.push(`  reverse_proxy ${upstream}`);
  }
  out.push('}');
  return out;
}
