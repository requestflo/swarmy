/**
 * The node log agent's collector `config.yaml` — pure, golden-tested.
 *
 * One agent per server (a global swarmy-system service) tails Docker's
 * json-file logs read-only and forwards them over OTLP to the org's
 * collector (the gateway), whose logs pipeline redacts and writes
 * `otel_logs` with the logs retention TTL. The agent itself:
 *
 *  - ships ONLY lines Docker stamped with the identity attrs
 *    (`swarmy.stack` / `swarmy.service`, see `@swarmy/core` container-logs) —
 *    swarmy's own services and plain containers carry none, so the agent
 *    never reads its own output back in a loop;
 *  - lifts them into resource attributes (+ `service.name`, so `ServiceName`
 *    matches what OTLP apps send) and stamps `swarmy.org_id` from THIS render,
 *    never from a label, and `swarmy.log.source=stdout`;
 *  - joins Docker's 16 KiB partial records, reads a level from the line when
 *    it says one (`level=warn`, `"level":"error"`, a bare `ERROR`), and
 *    checkpoints file offsets (and its send queue) on a node-local volume, so
 *    a restart resumes where it stopped instead of re-sending or skipping.
 *
 * Rotation: Docker rotates json-file by RENAME (`-json.log` → `.1` → `.2`).
 * The agent tails the rotated files too; a renamed file keeps its content
 * fingerprint, so it resumes at its checkpointed offset — the tail written
 * just before a rotation (even while the agent was down) is read once, never
 * twice. Compressed `.gz` files are never read.
 */
import { DOCKER_CONTAINERS_DIR, LOG_SOURCE_ATTR } from '@swarmy/core';
import { agentOperators, yq } from './observability-agent-operators';

export interface AgentRenderInput {
  /** The org this swarm belongs to — stamped on every line (the org wall). */
  orgId: string;
  /** The collector's OTLP gRPC endpoint (`host:port`) on the `swarmy` overlay. */
  gatewayEndpoint: string;
}

/** In-container path of the rendered config (a Docker config). */
export const AGENT_CONFIG_PATH = '/etc/otelcol-contrib/agent.yaml';
/** Offsets + send queue (a node-local named volume). */
export const AGENT_STATE_DIR = '/var/lib/otelcol/file_storage';
/** Env var the spec fills with the swarm node's hostname (`{{.Node.Hostname}}`). */
export const AGENT_NODE_ENV = 'SWARMY_NODE';

/** Render the agent `config.yaml`. Deterministic for a given input. */
export function renderAgentConfig(input: AgentRenderInput): string {
  return [
    '# Managed by swarmy (observability node agent). Do not edit by hand.',
    'extensions:',
    '  file_storage:',
    `    directory: ${AGENT_STATE_DIR}`,
    '    create_directory: true',
    '',
    'receivers:',
    '  filelog/containers:',
    // The rotated `.1`/`.2` too: a renamed file keeps its fingerprint, so it
    // resumes at its saved offset (nothing re-read) — and lines written while
    // the agent was down are still read after a rotation. Never the `.gz`.
    `    include: [${DOCKER_CONTAINERS_DIR}/*/*-json.log, ${DOCKER_CONTAINERS_DIR}/*/*-json.log.*]`,
    `    exclude: [${DOCKER_CONTAINERS_DIR}/*/*.gz]`,
    // Backlog already on disk at first start is skipped; files that appear
    // later (new tasks) are read from their first line.
    '    start_at: end',
    '    include_file_path: true',
    '    include_file_name: false',
    '    poll_interval: 500ms',
    '    max_log_size: 1MiB',
    '    max_concurrent_files: 512',
    '    storage: file_storage',
    ...agentOperators(),
    '',
    'processors:',
    '  memory_limiter:',
    '    check_interval: 1s',
    '    limit_mib: 200',
    '    spike_limit_mib: 50',
    '  transform/trim:',
    '    error_mode: ignore',
    '    log_statements:',
    '      - context: log',
    '        statements:',
    `          - ${yq('replace_pattern(body, "\\\\r?\\\\n$", "") where IsString(body)')}`,
    '  resource/agent:',
    '    attributes:',
    '      - key: swarmy.org_id',
    `        value: ${yq(input.orgId)}`,
    '        action: upsert',
    `      - key: ${LOG_SOURCE_ATTR}`,
    '        value: stdout',
    '        action: upsert',
    '      - key: host.name',
    `        value: \${env:${AGENT_NODE_ENV}}`,
    '        action: upsert',
    '  batch:',
    '    timeout: 2s',
    '    send_batch_size: 2000',
    '',
    'exporters:',
    '  otlp:',
    `    endpoint: ${input.gatewayEndpoint}`,
    '    tls:',
    '      insecure: true',
    '    sending_queue:',
    '      enabled: true',
    '      storage: file_storage',
    '      queue_size: 5000',
    '    retry_on_failure:',
    '      enabled: true',
    '      initial_interval: 5s',
    '      max_interval: 30s',
    '      max_elapsed_time: 30m',
    '',
    'service:',
    '  extensions: [file_storage]',
    '  telemetry:',
    '    logs:',
    '      level: warn',
    '  pipelines:',
    '    logs:',
    '      receivers: [filelog/containers]',
    '      processors: [memory_limiter, transform/trim, resource/agent, batch]',
    '      exporters: [otlp]',
    '',
  ].join('\n');
}
