/**
 * Pure halves of the ingress settings write: fold a patch into the stored
 * doc exactly where each per-field setter always wrote it, read the view
 * back, and name the one audit row. Secrets arrive here already sealed.
 */
import { defaultEdgeImage } from './ingress-controller';
import { readAcmeDnsSettings, withByoDnsProvider, type AcmeDnsSettings } from './acme-dns.service';
import { DRIVER_TO_ENUM, driverLower, type IngressSettings } from './ingress.service';
import type { IngressDriverEnum } from './ingress-config.repo';
import { patchFields, type CurrentIngressFacts, type IngressSettingsPatch, type IngressSettingsView } from './ingress-settings.schema';

/** The stored `ingress/<orgId>` swarm-kv doc. */
export interface IngressDoc {
  driver: IngressDriverEnum;
  enabled: boolean;
  settings: Record<string, unknown>;
}

/** Secret-derived inputs, computed once before the merge (which stays pure). */
export interface SealedIngressInputs {
  /** The encrypted tunnel run token. */
  runTokenEnc?: string;
  /** The tunnel id the run token decodes to. */
  tunnelId?: string | null;
  /** The BYO DNS provider coordinates (secret NAME only). */
  byo?: AcmeDnsSettings['byo'];
}

type GlobalOptions = Record<string, unknown> & { extraConfig?: Record<string, unknown> };

function mergeTls(g: GlobalOptions | undefined, tls: NonNullable<IngressSettingsPatch['tls']>): GlobalOptions {
  const out: GlobalOptions = { ...(g ?? {}) };
  if (tls.onDemand !== undefined) out.onDemandTls = tls.onDemand;
  if (tls.acmeEmail) out.email = tls.acmeEmail;
  else if (tls.acmeEmail === null) delete out.email;
  if (tls.askUrl !== undefined) {
    const extra = { ...(out.extraConfig ?? {}) };
    if (tls.askUrl) extra.onDemandAsk = tls.askUrl;
    else delete extra.onDemandAsk;
    out.extraConfig = extra;
  }
  return out;
}

/** Fold `patch` (all but `topology`, which only lands once its swap deployed) into `doc`. */
export function mergeIngressPatch(doc: IngressDoc, patch: IngressSettingsPatch, sealed: SealedIngressInputs): IngressDoc {
  const s: IngressSettings = { ...(doc.settings as IngressSettings) };
  if (patch.controllerImage !== undefined) s.controllerImage = patch.controllerImage ?? undefined;
  if (patch.targetNodes) s.targetNodes = patch.targetNodes;
  if (patch.tls) s.globalOptions = mergeTls(s.globalOptions as GlobalOptions | undefined, patch.tls);
  if (patch.tunnel === null) s.tunnel = undefined;
  else if (patch.tunnel) {
    const t = s.tunnel;
    s.tunnel = {
      ...t,
      provider: 'cloudflare',
      tunnelId: sealed.tunnelId ?? t?.tunnelId,
      tunnelName: patch.tunnel.tunnelName ?? t?.tunnelName ?? 'swarmy',
      replicas: patch.tunnel.replicas ?? t?.replicas,
      runTokenEnc: sealed.runTokenEnc ?? t?.runTokenEnc,
    };
  }
  let settings = s as Record<string, unknown>;
  if (patch.dnsProvider !== undefined) settings = withByoDnsProvider(settings, patch.dnsProvider ? sealed.byo ?? null : null);
  return {
    driver: patch.driver ? DRIVER_TO_ENUM[patch.driver] : doc.driver,
    enabled: patch.enabled ?? doc.enabled,
    settings,
  };
}

/** The facts `assertIngressPatch` judges a patch against. */
export function currentFacts(doc: IngressDoc): CurrentIngressFacts {
  const s = doc.settings as IngressSettings;
  const g = (s.globalOptions ?? {}) as GlobalOptions;
  const str = (v: unknown) => (typeof v === 'string' && v ? v : null);
  return {
    acmeEmail: str(g.email),
    onDemand: g.onDemandTls === true,
    askUrl: str(g.extraConfig?.onDemandAsk),
    tunnelConfigured: Boolean(s.tunnel?.tunnelId || s.tunnel?.runTokenEnc),
  };
}

/** The readable view of a stored doc — secrets reduced to set / not set. */
export function ingressSettingsView(orgId: string, doc: IngressDoc, updatedAt: Date): IngressSettingsView {
  const s = doc.settings as IngressSettings;
  const facts = currentFacts(doc);
  const byo = readAcmeDnsSettings(doc.settings).byo;
  return {
    orgId,
    driver: driverLower(doc.driver),
    enabled: doc.enabled,
    topology: s.topology ?? 'controller',
    controllerImage: s.controllerImage ?? null,
    defaultControllerImage: defaultEdgeImage(),
    targetNodes: s.targetNodes ?? [],
    tls: { acmeEmail: facts.acmeEmail, onDemand: facts.onDemand, askUrl: facts.askUrl },
    tunnel: s.tunnel && facts.tunnelConfigured
      ? {
          tunnelId: s.tunnel.tunnelId ?? null,
          tunnelName: s.tunnel.tunnelName ?? 'swarmy',
          replicas: s.tunnel.replicas ?? 1,
          runTokenSet: Boolean(s.tunnel.runTokenEnc),
        }
      : null,
    dnsProvider: byo ? { provider: byo.provider, setAt: byo.setAt, apiTokenSet: Boolean(byo.secretName) } : null,
    updatedAt: updatedAt.toISOString(),
  };
}

/**
 * The ONE audit row of a write. A single-field patch keeps the action its
 * setter always wrote (`ingress.setDriver`, `ingress.clearTunnel`, …); a
 * multi-field one is `ingress.updateSettings` with each field's metadata.
 * Never a secret: tunnels by id, DNS tokens by secret name.
 */
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
