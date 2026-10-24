/**
 * The node log agent tier — pure spec, configs and converge plan (the IO is
 * `observability-agent.service.ts`; the reconcile worker only schedules it).
 *
 * One `swarmy-otel-agent` task per server (a GLOBAL swarmy-system service),
 * deployed through the existing `service.deploy` path like the rest of the
 * suite. It mounts Docker's container log directory READ-ONLY and keeps its
 * offsets on a node-local volume. It runs as root only because json-file
 * logs are root-readable (0640); it has no Docker socket and publishes no
 * port. Its config is a content-addressed Docker config (`<prefix>-<sha8>`)
 * carrying no secret — the agent needs none: it sends to the collector on
 * the `swarmy` overlay, which apps already reach.
 */
import { DOCKER_CONTAINERS_DIR, SYSTEM_STACK, SYSTEM_STACK_LABEL, STACK_LABEL } from '@swarmy/core';
import type { ServiceSpec, SwarmServiceInfo } from '@swarmy/core/protocol';
import { AGENT_CONFIG_PATH, AGENT_NODE_ENV, AGENT_STATE_DIR, renderAgentConfig } from './observability-agent-render';
import {
  COLLECTOR_IMAGE,
  COLLECTOR_SERVICE,
  contentConfigName,
  OTEL_OVERLAY_NETWORK,
  OTLP_GRPC_PORT,
  type ObservabilityConfigObject,
} from './observability-stack';

export const AGENT_SERVICE = 'swarmy-otel-agent';
export const AGENT_CONFIG_PREFIX = `${AGENT_SERVICE}-config`;
/** Node-local volume holding the agent's offsets + send queue. */
export const AGENT_STATE_VOLUME = 'swarmy-otel-agent-state';

const MiB = 1024 * 1024;

export interface AgentDesired {
  config: ObservabilityConfigObject;
  spec: ServiceSpec;
}

/** The rendered agent config as a content-addressed Docker config. */
export function agentConfig(orgId: string): ObservabilityConfigObject {
  const contents = renderAgentConfig({ orgId, gatewayEndpoint: `${COLLECTOR_SERVICE}:${OTLP_GRPC_PORT}` });
  return { name: contentConfigName(AGENT_CONFIG_PREFIX, contents), contents, target: AGENT_CONFIG_PATH };
}

export function agentServiceSpec(opts: { config: string }): ServiceSpec {
  return {
    name: AGENT_SERVICE,
    image: COLLECTOR_IMAGE,
    mode: { global: {} },
    labels: {
      'swarmy.managed': 'true',
      'swarmy.component': 'observability',
      'swarmy.role': 'log-agent',
      [STACK_LABEL]: SYSTEM_STACK,
      [SYSTEM_STACK_LABEL]: 'true',
    },
    args: ['--config', AGENT_CONFIG_PATH],
    // json-file logs are 0640 root — read-only mount, no socket, no port.
    user: '0',
    // Swarm fills the template per task: each line says which server it came from.
    env: { [AGENT_NODE_ENV]: '{{.Node.Hostname}}' },
    mounts: [
      { type: 'bind', source: DOCKER_CONTAINERS_DIR, target: DOCKER_CONTAINERS_DIR, readOnly: true },
      { type: 'volume', source: AGENT_STATE_VOLUME, target: AGENT_STATE_DIR },
    ],
    configs: [{ source: opts.config, target: AGENT_CONFIG_PATH, mode: 0o444 }],
    networks: [OTEL_OVERLAY_NETWORK],
    resources: {
      limits: { cpus: 0.5, memoryBytes: 256 * MiB },
      reservations: { memoryBytes: 64 * MiB },
    },
    // stop-first: the offsets file is locked by one process per node, and two
    // agents on one server would ship every line twice.
    updateConfig: { parallelism: 1, order: 'stop-first', failureAction: 'continue' },
    restartPolicy: { condition: 'any', delayNs: 5_000_000_000 },
  };
}

/** What should run: the agent when the suite is on AND the org collects container output. */
export function desiredAgent(input: { orgId: string; enabled: boolean }): AgentDesired | null {
  if (!input.enabled) return null;
  const config = agentConfig(input.orgId);
  return { config, spec: agentServiceSpec({ config: config.name }) };
}

export type AgentAction = 'deploy' | 'remove' | 'none';

/** Close the gap between the desired agent and the live service. Pure. */
export function planAgent(input: {
  desired: AgentDesired | null;
  live?: Pick<SwarmServiceInfo, 'configs'>;
}): AgentAction {
  if (!input.desired) return input.live ? 'remove' : 'none';
  if (!input.live) return 'deploy';
  return (input.live.configs ?? []).includes(input.desired.config.name) ? 'none' : 'deploy';
}

/**
 * The converge signature: what we want × what runs. A tick whose signature
 * matches the last dispatched one sends nothing (the inventory has not caught
 * up yet, or an older agent never reports configs).
 */
export function agentSignature(desired: AgentDesired | null, live?: Pick<SwarmServiceInfo, 'configs'>): string {
  const want = desired ? desired.config.name : 'off';
  const have = live ? (live.configs ?? []).filter((c) => c.startsWith(AGENT_CONFIG_PREFIX)).sort().join(',') || 'running' : 'absent';
  return `${want}|${have}`;
}

/** Agent configs safe to remove: ours, not kept, not referenced by a live service. Pure. */
export function staleAgentConfigs(existing: readonly string[], keep: readonly string[], referenced: readonly string[] = []): string[] {
  const keepSet = new Set([...keep, ...referenced]);
  return existing.filter((n) => n.startsWith(`${AGENT_CONFIG_PREFIX}-`) && !keepSet.has(n));
}
