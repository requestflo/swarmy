/**
 * The ONE audit row of an ingress settings write — pure. A single-field
 * patch keeps the action its setter always wrote (`ingress.setDriver`,
 * `ingress.clearTunnel`, `ingress.setEdgeGeoip`, …); a multi-field one is
 * `ingress.updateSettings` with each field's metadata. Never a secret:
 * tunnels by id, DNS tokens by secret name.
 */
import { normalizeAutoAddressBase } from '@swarmy/ingress';
import { patchFields, type IngressSettingsPatch } from './ingress-settings.schema';

export function ingressAudit(
  patch: IngressSettingsPatch,
  facts: { previousTopology: string; tunnelId: string | null; byoSecretName?: string },
): { action: string; metadata: Record<string, unknown> } {
  const one = {
    driver: () => ['ingress.setDriver', { driver: patch.driver }],
    enabled: () => ['ingress.setEnabled', { enabled: patch.enabled }],
    topology: () => ['ingress.setTopology', { topology: patch.topology, previous: facts.previousTopology }],
    controllerImage: () => [patch.controllerImage ? 'ingress.setControllerImage' : 'ingress.clearControllerImage', { image: patch.controllerImage }],
    targetNodes: () => ['ingress.setTargetNodes', { nodeIds: patch.targetNodes }],
    tls: () => [
      patch.tls?.acmeEmail !== undefined ? 'ingress.setTls' : 'ingress.setOnDemandTls',
      { enabled: patch.tls?.onDemand, ...(patch.tls?.acmeEmail !== undefined ? { acmeEmail: patch.tls.acmeEmail } : {}) },
    ],
    tunnel: () => [patch.tunnel ? 'ingress.setTunnel' : 'ingress.clearTunnel', { tunnelId: facts.tunnelId }],
    dnsProvider: () => [
      patch.dnsProvider ? 'ingress.setDnsProvider' : 'ingress.clearDnsProvider',
      patch.dnsProvider ? { provider: patch.dnsProvider.provider, secretName: facts.byoSecretName } : {},
    ],
    geoip: () => [
      'ingress.setEdgeGeoip',
      patch.geoip?.mode === 'file' ? { ...patch.geoip } : { mode: patch.geoip?.mode },
    ],
    autoAddressBase: () => [
      'ingress.setAutoAddressBase',
      { base: normalizeAutoAddressBase(patch.autoAddressBase) ?? 'unset' },
    ],
  } satisfies Record<keyof IngressSettingsPatch, () => [string, Record<string, unknown>]>;
  const fields = patchFields(patch);
  if (fields.length === 1) {
    const [action, metadata] = one[fields[0]!]();
    return { action, metadata };
  }
  return {
    action: 'ingress.updateSettings',
    metadata: { fields, changes: Object.fromEntries(fields.map((f) => [f, one[f]()[1]])) },
  };
}
