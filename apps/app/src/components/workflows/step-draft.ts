import type { WorkflowStepInput, WorkflowStepKind, WorkflowStepView } from '@swarmy/core';

/** Builder-local editing shape for one step (strings for every field). */
export interface StepDraft {
  name: string;
  kind: WorkflowStepKind;
  image: string;
  /** One command line; quoted args supported (see splitCommand). */
  command: string;
  /** KEY=VALUE, one per line. */
  env: string;
  serviceRef: string;
  url: string;
  secret: string;
  /** Editing an existing webhook step that already stores a secret. */
  hasStoredSecret: boolean;
  prompt: string;
  seconds: number;
  timeoutSec: number;
  retries: number;
}

export function emptyStep(kind: WorkflowStepKind, index: number): StepDraft {
  return {
    name: `step-${index + 1}`,
    kind,
    image: '',
    command: '',
    env: '',
    serviceRef: '',
    url: '',
    secret: '',
    hasStoredSecret: false,
    prompt: '',
    seconds: 60,
    timeoutSec: 600,
    retries: 0,
  };
}

/** Split a command line into argv, honouring '…' and "…" quoting. */
export function splitCommand(line: string): string[] {
  const out: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  for (const m of line.matchAll(re)) out.push(m[1] ?? m[2] ?? m[3] ?? '');
  return out.filter((s) => s.length > 0);
}

/** KEY=VALUE lines → env record (blank/invalid lines skipped). */
export function parseEnvLines(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    out[line.slice(0, eq).trim()] = line.slice(eq + 1);
  }
  return out;
}

export function toDraft(step: WorkflowStepView): StepDraft {
  return {
    name: step.name,
    kind: step.kind,
    image: step.config.image ?? '',
    command: (step.config.command ?? []).map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(' '),
    env: Object.entries(step.config.env ?? {})
      .map(([k, v]) => `${k}=${v}`)
      .join('\n'),
    serviceRef: step.config.serviceRef ?? '',
    url: step.config.url ?? '',
    secret: '',
    hasStoredSecret: Boolean(step.config.hasSecret),
    prompt: step.config.prompt ?? '',
    seconds: step.config.seconds ?? 60,
    timeoutSec: Math.round((step.timeoutMs ?? 600_000) / 1000),
    retries: step.retries ?? 0,
  };
}

/** Draft → wire input (only the fields the kind uses). */
export function fromDraft(d: StepDraft): WorkflowStepInput {
  const config: WorkflowStepInput['config'] = {};
  if (d.kind === 'container') {
    config.image = d.image.trim();
    const command = splitCommand(d.command);
    if (command.length > 0) config.command = command;
    const env = parseEnvLines(d.env);
    if (Object.keys(env).length > 0) config.env = env;
  } else if (d.kind === 'service-exec') {
    config.serviceRef = d.serviceRef.trim();
    config.command = splitCommand(d.command);
  } else if (d.kind === 'webhook') {
    config.url = d.url.trim();
    if (d.secret.trim()) config.secret = d.secret.trim();
  } else if (d.kind === 'approval') {
    if (d.prompt.trim()) config.prompt = d.prompt.trim();
  } else {
    config.seconds = Math.max(1, d.seconds);
  }
  return {
    name: d.name.trim(),
    kind: d.kind,
    config,
    ...(d.kind !== 'approval' && d.kind !== 'delay'
      ? { timeoutMs: Math.max(1, d.timeoutSec) * 1000, retries: d.retries }
      : {}),
  };
}

/** Cheap client-side gate for the submit button (server re-validates). */
export function draftProblems(steps: StepDraft[]): string[] {
  const problems: string[] = [];
  if (steps.length === 0) problems.push('add at least one step');
  const seen = new Set<string>();
  for (const s of steps) {
    if (!/^[a-z0-9][a-z0-9-]*$/.test(s.name)) problems.push(`"${s.name || '(unnamed)'}": lowercase-dashes name`);
    if (seen.has(s.name)) problems.push(`duplicate step name "${s.name}"`);
    seen.add(s.name);
    if (s.kind === 'container' && !s.image.trim()) problems.push(`"${s.name}": image required`);
    if (s.kind === 'service-exec' && (!s.serviceRef.trim() || splitCommand(s.command).length === 0)) {
      problems.push(`"${s.name}": service + command required`);
    }
    if (s.kind === 'webhook' && !/^https?:\/\/\S+$/i.test(s.url.trim())) {
      problems.push(`"${s.name}": http(s) URL required`);
    }
    if (s.kind === 'delay' && s.seconds < 1) problems.push(`"${s.name}": seconds ≥ 1`);
  }
  return problems;
}
