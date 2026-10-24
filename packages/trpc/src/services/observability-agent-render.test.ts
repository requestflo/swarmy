import { describe, expect, it } from 'bun:test';
import { renderAgentConfig } from './observability-agent-render';

/**
 * Golden: the node agent config byte-for-byte. It was also run through the
 * pinned otelcol-contrib 0.111.0 image against json-file fixtures (identity
 * filter, 16 KiB partials, levels, rename rotation, restart resume).
 */
const GOLDEN = `# Managed by swarmy (observability node agent). Do not edit by hand.
extensions:
  file_storage:
    directory: /var/lib/otelcol/file_storage
    create_directory: true

receivers:
  filelog/containers:
    include: [/var/lib/docker/containers/*/*-json.log, /var/lib/docker/containers/*/*-json.log.*]
    exclude: [/var/lib/docker/containers/*/*.gz]
    start_at: end
    include_file_path: true
    include_file_name: false
    poll_interval: 500ms
    max_log_size: 1MiB
    max_concurrent_files: 512
    storage: file_storage
    operators:
      - type: json_parser
        id: docker-line
        timestamp:
          parse_from: attributes.time
          layout_type: gotime
          layout: '2006-01-02T15:04:05.999999999Z07:00'
      - type: filter
        id: only-swarmy-apps
        expr: 'attributes.attrs == nil or attributes.attrs["swarmy.service"] == nil or attributes.attrs["swarmy.stack"] == "swarmy-system"'
      - type: recombine
        id: docker-partials
        combine_field: attributes.log
        source_identifier: attributes["log.file.path"]
        is_last_entry: 'attributes.log endsWith "\\n"'
        combine_with: ''
        max_log_size: 1MiB
      - type: move
        from: attributes.log
        to: body
      - type: move
        from: attributes.stream
        to: attributes["log.iostream"]
      - type: move
        from: attributes.attrs["swarmy.stack"]
        to: resource["swarmy.stack"]
      - type: copy
        from: attributes.attrs["swarmy.service"]
        to: resource["service.name"]
      - type: move
        from: attributes.attrs["swarmy.service"]
        to: resource["swarmy.service"]
      - type: remove
        field: attributes.attrs
      - type: remove
        field: attributes.time
      - type: remove
        field: attributes["log.file.path"]
      - type: regex_parser
        id: level-key
        if: 'body matches "(?i)\\\\b(?:level|lvl|severity)\\\\W{0,2}[=:]\\\\W{0,2}(?P<sev>[a-z]+)"'
        parse_from: body
        regex: '(?i)\\b(?:level|lvl|severity)\\W{0,2}[=:]\\W{0,2}(?P<sev>[a-z]+)'
      - type: regex_parser
        id: level-word
        if: 'attributes.sev == nil and body matches "\\\\b(?P<sev>TRACE|DEBUG|INFO|WARN|WARNING|ERROR|FATAL|PANIC|CRITICAL)\\\\b"'
        parse_from: body
        regex: '\\b(?P<sev>TRACE|DEBUG|INFO|WARN|WARNING|ERROR|FATAL|PANIC|CRITICAL)\\b'
      - type: severity_parser
        if: 'attributes.sev != nil'
        parse_from: attributes.sev
        mapping:
          warn: [warning, WARNING, Warning]
          error: [err, ERR]
          fatal: [panic, PANIC, critical, CRITICAL, crit, CRIT]
      - type: remove
        if: 'attributes.sev != nil'
        field: attributes.sev

processors:
  memory_limiter:
    check_interval: 1s
    limit_mib: 200
    spike_limit_mib: 50
  transform/trim:
    error_mode: ignore
    log_statements:
      - context: log
        statements:
          - 'replace_pattern(body, "\\\\r?\\\\n$", "") where IsString(body)'
  resource/agent:
    attributes:
      - key: swarmy.org_id
        value: 'org_abc'
        action: upsert
      - key: swarmy.log.source
        value: stdout
        action: upsert
      - key: host.name
        value: \${env:SWARMY_NODE}
        action: upsert
  batch:
    timeout: 2s
    send_batch_size: 2000

exporters:
  otlp:
    endpoint: swarmy-otel-collector:4317
    tls:
      insecure: true
    sending_queue:
      enabled: true
      storage: file_storage
      queue_size: 5000
    retry_on_failure:
      enabled: true
      initial_interval: 5s
      max_interval: 30s
      max_elapsed_time: 30m

service:
  extensions: [file_storage]
  telemetry:
    logs:
      level: warn
  pipelines:
    logs:
      receivers: [filelog/containers]
      processors: [memory_limiter, transform/trim, resource/agent, batch]
      exporters: [otlp]
`;

describe('renderAgentConfig (node log agent)', () => {
  it('is the golden YAML', () => {
    expect(renderAgentConfig({ orgId: 'org_abc', gatewayEndpoint: 'swarmy-otel-collector:4317' })).toBe(GOLDEN);
  });

  it('stamps the org from the render, YAML-escaped, and never reads it from a label', () => {
    const y = renderAgentConfig({ orgId: "o'1", gatewayEndpoint: 'gw:4317' });
    expect(y).toContain("value: 'o''1'");
    expect(y).not.toContain('attrs["swarmy.org_id"]');
    expect(y).toContain('endpoint: gw:4317');
  });
});
