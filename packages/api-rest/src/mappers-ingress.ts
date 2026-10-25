/**
 * Ingress settings: service view → public DTO, and PUT body → service patch.
 * The only place the camelCase ↔ snake_case translation happens for them.
 */
import type { z } from '@hono/zod-openapi';
import type { IngressSettingsPatch, IngressSettingsView } from '@swarmy/trpc';
import type { IngressSettingsDto, UpdateIngressSettingsBody } from './dto-ingress';

export function ingressSettingsToDto(v: IngressSettingsView): z.infer<typeof IngressSettingsDto> {
  return {
    org_id: v.orgId,
    driver: v.driver,
    enabled: v.enabled,
    topology: v.topology,
    controller_image: v.controllerImage,
    default_controller_image: v.defaultControllerImage,
    target_nodes: v.targetNodes,
    tls: { acme_email: v.tls.acmeEmail, on_demand: v.tls.onDemand, ask_url: v.tls.askUrl },
    tunnel: v.tunnel
      ? {
          tunnel_id: v.tunnel.tunnelId,
          tunnel_name: v.tunnel.tunnelName,
          replicas: v.tunnel.replicas,
          run_token_set: v.tunnel.runTokenSet,
        }
      : null,
    dns_provider: v.dnsProvider
      ? { provider: v.dnsProvider.provider, api_token_set: v.dnsProvider.apiTokenSet, set_at: v.dnsProvider.setAt }
      : null,
    geoip: { mode: v.geoip.mode, path: v.geoip.path },
    auto_address_base: v.autoAddressBase,
    updated_at: v.updatedAt,
  };
}

/** Drop `undefined` keys so "left out" stays left out (the service treats `null` as clear). */
function defined<T extends Record<string, unknown>>(o: T): T {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;
}

export function ingressSettingsBodyToPatch(b: z.infer<typeof UpdateIngressSettingsBody>): IngressSettingsPatch {
  return defined({
    driver: b.driver,
    enabled: b.enabled,
    topology: b.topology,
    controllerImage: b.controller_image,
    targetNodes: b.target_nodes,
    tls: b.tls ? defined({ acmeEmail: b.tls.acme_email, onDemand: b.tls.on_demand, askUrl: b.tls.ask_url }) : undefined,
    tunnel:
      b.tunnel === null
        ? null
        : b.tunnel
          ? defined({ runToken: b.tunnel.run_token, tunnelName: b.tunnel.tunnel_name, replicas: b.tunnel.replicas })
          : undefined,
    dnsProvider:
      b.dns_provider === null
        ? null
        : b.dns_provider
          ? { provider: b.dns_provider.provider, apiToken: b.dns_provider.api_token }
          : undefined,
    geoip: b.geoip ? defined({ mode: b.geoip.mode, path: b.geoip.path }) : undefined,
    autoAddressBase: b.auto_address_base,
  });
}
