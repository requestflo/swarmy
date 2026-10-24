/**
 * The node agent's filelog operators (stanza) — one Docker json-file line in,
 * one attributed log record out. Pure; rendered into the agent config by
 * `observability-agent-render.ts` and pinned by its golden.
 *
 *   json_parser   `{"log","stream","attrs","time"}` + the line's own timestamp
 *   filter        no identity attrs (swarmy's own services, plain containers)
 *                 or the swarmy-system stack → dropped before any other work
 *   recombine     Docker's 16 KiB partial records joined back into one line
 *   move/copy     attrs → resource `swarmy.stack` / `swarmy.service` /
 *                 `service.name`; `stream` → `log.iostream`
 *   regex+severity a level the line states itself (`level=warn`,
 *                 `"level":"error"`, a bare `ERROR`); otherwise unspecified
 */
import { LOG_SERVICE_LABEL, LOG_STACK_LABEL, SYSTEM_STACK } from '@swarmy/core';

/** A YAML single-quoted scalar. */
export const yq = (s: string): string => `'${s.replace(/'/g, "''")}'`;
const attr = (key: string): string => `attributes.attrs[${JSON.stringify(key)}]`;

const LEVEL_KEY = String.raw`(?i)\b(?:level|lvl|severity)\W{0,2}[=:]\W{0,2}(?P<sev>[a-z]+)`;
const LEVEL_WORD = String.raw`\b(?P<sev>TRACE|DEBUG|INFO|WARN|WARNING|ERROR|FATAL|PANIC|CRITICAL)\b`;
/** An expr-lang `matches` test on the body (the regex as a double-quoted expr string). */
const bodyMatches = (re: string): string => `body matches ${JSON.stringify(re)}`;

const move = (from: string, to: string, type = 'move'): string[] => [`      - type: ${type}`, `        from: ${from}`, `        to: ${to}`];
const remove = (field: string, cond?: string): string[] => [
  '      - type: remove',
  ...(cond ? [`        if: ${yq(cond)}`] : []),
  `        field: ${field}`,
];

/** The `operators:` block of the filelog receiver (indented under it). */
export function agentOperators(): string[] {
  return [
    '    operators:',
    '      - type: json_parser',
    '        id: docker-line',
    '        timestamp:',
    '          parse_from: attributes.time',
    '          layout_type: gotime',
    `          layout: ${yq('2006-01-02T15:04:05.999999999Z07:00')}`,
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
