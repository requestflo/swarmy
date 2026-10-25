/**
 * Public DTOs for the org's ingress settings (`GET/PUT /ingress/settings`).
 * Same conventions as `dto.ts`: snake_case, `.openapi(name)` on every schema.
 * Secrets are write-only: the read says whether one is set, never its value.
 */
import { z } from '@hono/zod-openapi';

const IngressDriverDto = z.enum(['caddy', 'none', 'cloudflared']).openapi('IngressDriver', {
  description:
    '`caddy` swarmy runs Caddy on 80/443; `cloudflared` a Cloudflare Tunnel (no public IP); `none` you run your own proxy. Open enum: new values may be added.',
});

const IngressTopologyDto = z.enum(['controller', 'edge-per-node']).openapi('IngressTopology', {
  description:
    '`controller` one replicated Caddy; `edge-per-node` a host-mode Caddy on every ingress node (needs an ingress-labelled node and swarmy object storage). Switching removes and recreates the edge service (seconds of downtime). Open enum.',
});

const IngressTlsDto = z
  .object({
    acme_email: z.string().nullable().openapi({ description: 'ACME account email (certificate expiry notices).' }),
    on_demand: z.boolean().openapi({ description: 'Certificates are issued on demand for customer domains.' }),
    ask_url: z.string().nullable().openapi({ description: 'The endpoint Caddy asks before issuing on demand.' }),
  })
  .openapi('IngressTls');

const IngressTunnelDto = z
  .object({
    tunnel_id: z.string().nullable(),
    tunnel_name: z.string(),
    replicas: z.number().int(),
    run_token_set: z.boolean().openapi({ description: 'A run token is stored (encrypted). It is never returned.' }),
  })
  .openapi('IngressTunnel');

const IngressDnsProviderDto = z
  .object({
    provider: z.enum(['cloudflare']).openapi({ description: 'Open enum.' }),
    api_token_set: z.boolean().openapi({ description: 'The token is in a Docker secret. It is never returned.' }),
    set_at: z.string(),
  })
  .openapi('IngressDnsProvider');

const IngressGeoipModeDto = z.enum(['bundled', 'file', 'off']).openapi('IngressGeoipMode', {
  description:
    '`bundled` the DB-IP Country Lite copy in swarmy’s Caddy build (IP Geolocation by DB-IP, CC BY 4.0); `file` an mmdb already inside the edge container; `off` country rules are saved but not enforced. Open enum.',
});

const IngressGeoipDto = z
  .object({
    mode: IngressGeoipModeDto,
    path: z.string().nullable().openapi({ description: 'The mmdb path inside the edge container (`file` only).' }),
  })
  .openapi('IngressGeoip', { description: 'The country database the edge’s country allow/deny rules read.' });

export const IngressSettingsDto = z
  .object({
    org_id: z.string(),
    driver: IngressDriverDto,
    enabled: z.boolean(),
    topology: IngressTopologyDto,
    controller_image: z.string().nullable().openapi({ description: 'Custom Caddy image; null = `default_controller_image`.' }),
    default_controller_image: z.string(),
    target_nodes: z.array(z.string()).openapi({ description: 'Node ids the replicated controller is pinned to (empty = no pin).' }),
    tls: IngressTlsDto,
    tunnel: IngressTunnelDto.nullable().openapi({ description: 'The Cloudflare tunnel, or null when none is connected.' }),
    dns_provider: IngressDnsProviderDto.nullable().openapi({
      description: 'BYO DNS provider for wildcard certificates in zones swarmy DNS does not serve, or null.',
    }),
    geoip: IngressGeoipDto,
    auto_address_base: z.string().nullable().openapi({
      description: 'The workspace’s wildcard-IP base for automatic addresses (e.g. `nip.io`); null = the controller default (sslip.io unless set).',
    }),
    updated_at: z.string(),
  })
  .openapi('IngressSettings');

const IngressTlsInput = z
  .object({
    acme_email: z.string().email().max(254).nullable().optional().openapi({ description: '`null` clears it.' }),
    on_demand: z.boolean().optional(),
    ask_url: z.string().url().max(2048).nullable().optional().openapi({ description: '`null` clears it.' }),
  })
  .strict()
  .openapi('IngressTlsInput', {
    description: 'On-demand TLS needs an ACME email or an ask endpoint (after the change).',
  });

const IngressTunnelInput = z
  .object({
    run_token: z.string().min(20).max(4096).optional().openapi({
      description: 'Cloudflare tunnel run token (write-only, encrypted at rest; the tunnel id is read from it). Required to connect.',
    }),
    tunnel_name: z.string().max(100).optional(),
    replicas: z.number().int().min(1).max(10).optional(),
  })
  .strict()
  .openapi('IngressTunnelInput');

const IngressDnsProviderInput = z
  .object({
    provider: z.enum(['cloudflare']),
    api_token: z.string().min(20).max(512).openapi({ description: 'Provider API token (Zone:DNS:Edit). Write-only: stored only in a Docker secret.' }),
  })
  .strict()
  .openapi('IngressDnsProviderInput');

const IngressGeoipInput = z
  .object({
    mode: IngressGeoipModeDto,
    path: z.string().optional().openapi({ description: 'Required for `file`: an absolute path to a `.mmdb` inside the edge container.' }),
  })
  .strict()
  .openapi('IngressGeoipInput');

/** PUT body: a field left out keeps its current value; `null` clears a nullable one. */
export const UpdateIngressSettingsBody = z
  .object({
    driver: IngressDriverDto.optional(),
    enabled: z.boolean().optional(),
    topology: IngressTopologyDto.optional().openapi({ description: 'The current topology is a no-op (nothing is recreated).' }),
    controller_image: z.string().min(1).max(512).nullable().optional().openapi({ description: '`null` = the default image.' }),
    target_nodes: z.array(z.string()).max(256).optional(),
    tls: IngressTlsInput.optional(),
    tunnel: IngressTunnelInput.nullable().optional().openapi({ description: '`null` disconnects the tunnel.' }),
    dns_provider: IngressDnsProviderInput.nullable().optional().openapi({ description: '`null` clears the provider.' }),
    geoip: IngressGeoipInput.optional(),
    auto_address_base: z.string().max(253).nullable().optional().openapi({
      description: 'A wildcard-IP DNS service (`<x>.<a-b-c-d>.<base>` must resolve to a.b.c.d); `null` or empty clears it. Automatic addresses move on the next domain check.',
    }),
  })
  .strict()
  .openapi('UpdateIngressSettingsRequest', {
    description: 'Fields left out keep their current value; `null` clears a nullable one. Validated as a whole before anything changes; the edge then converges once.',
  });
