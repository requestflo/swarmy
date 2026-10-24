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
import { DOCKER_CONTAINERS_DIR, LOG_SERVICE_LABEL, LOG_SOURCE_ATTR, LOG_STACK_LABEL, SYSTEM_STACK } from '@swarmy/core';

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

/** A YAML single-quoted scalar. */
const yq = (s: string): string => `'${s.replace(/'/g, "''")}'`;
const attr = (key: string): string => `attributes.attrs[${JSON.stringify(key)}]`;

const LEVEL_KEY = String.raw`(?i)\b(?:level|lvl|severity)\W{0,2}[=:]\W{0,2}(?P<sev>[a-z]+)`;
const LEVEL_WORD = String.raw`\b(?P<sev>TRACE|DEBUG|INFO|WARN|WARNING|ERROR|FATAL|PANIC|CRITICAL)\b`;
/** An expr-lang `matches` test on the body (the regex as a double-quoted expr string). */
const bodyMatches = (re: string): string => `body matches ${JSON.stringify(re)}`;

function operators(): string[] {
  const move = (from: string, to: string, type = 'move') => [`      - type: ${type}`, `        from: ${from}`, `        to: ${to}`];
  const remove = (field: string, cond?: string) => [
    '      - type: remove',
    ...(cond ? [`        if: ${yq(cond)}`] : []),
    `        field: ${field}`,
  ];
  return [
    '    operators:',
    '      - type: json_parser',
    '        id: docker-line',
    '        timestamp:',
    '          parse_from: attributes.time',
    '          layout_type: gotime',
    `          layout: ${yq('2006-01-02T15:04:05.999999999Z07:00')}`,
    // Lines without the identity attrs are not an app swarmy deployed with
    // collection on (or are swarmy's own) — dropped before any other work.
    '      - type: filter',
    '        id: only-swarmy-apps',
    `        expr: ${yq(`attributes.attrs == nil or ${attr(LOG_SERVICE_LABEL)} == nil or ${attr(LOG_STACK_LABEL)} == ${JSON.stringify(SYSTEM_STACK)}`)}`,
    '      - type: recombine',
    '        id: docker-partials',
    '        combine_field: attributes.log',
    `        source_identifier: attributes["log.file.path"]`,
    `        is_last_entry: ${yq('attributes.log endsWith "\\n"')}`,
    `        combine_with: ''`,
    '        max_log_size: 1MiB',
    ...move('attributes.log', 'body'),
    ...move('attributes.stream', 'attributes["log.iostream"]'),
    ...move(attr(LOG_STACK_LABEL), `resource[${JSON.stringify(LOG_STACK_LABEL)}]`),
    ...move(attr(LOG_SERVICE_LABEL), 'resource["service.name"]', 'copy'),
    ...move(attr(LOG_SERVICE_LABEL), `resource[${JSON.stringify(LOG_SERVICE_LABEL)}]`),
    ...remove('attributes.attrs'),
    ...remove('attributes.time'),
    ...remove('attributes["log.file.path"]'),
    // A level the line states itself; otherwise the line stays unspecified.
    '      - type: regex_parser',
    '        id: level-key',
    `        if: ${yq(bodyMatches(LEVEL_KEY))}`,
    '        parse_from: body',
    `        regex: ${yq(LEVEL_KEY)}`,
    '      - type: regex_parser',
    '        id: level-word',
    `        if: ${yq(`attributes.sev == nil and ${bodyMatches(LEVEL_WORD)}`)}`,
    '        parse_from: body',
    `        regex: ${yq(LEVEL_WORD)}`,
    '      - type: severity_parser',
    `        if: ${yq('attributes.sev != nil')}`,
    '        parse_from: attributes.sev',
    '        mapping:',
    '          warn: [warning, WARNING, Warning]',
    '          error: [err, ERR]',
    '          fatal: [panic, PANIC, critical, CRITICAL, crit, CRIT]',
    ...remove('attributes.sev', 'attributes.sev != nil'),
  ];
}

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
    ...operators(),
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
