import type { CreateScheduledJobInput, JobKind, ScheduledJobView } from '@swarmy/core';

/**
 * Dialog draft ↔ wire conversion. The command is edited as one shell line and
 * shipped as `['sh', '-c', line]` (predictable cron semantics; noted in the
 * form); env is edited as KEY=VALUE lines, placement labels as `key=value`
 * pairs.
 */

export interface JobDraft {
  name: string;
  schedule: string;
  kind: JobKind;
  image: string;
  serviceRef: string;
  command: string;
  env: string;
  runOnLabels: string;
  timeoutMin: number;
  retries: number;
  alertOnFailure: boolean;
}

export const EMPTY_DRAFT: JobDraft = {
  name: '',
  schedule: '0 2 * * *',
  kind: 'image',
  image: '',
  serviceRef: '',
  command: '',
  env: '',
  runOnLabels: '',
  timeoutMin: 10,
  retries: 0,
  alertOnFailure: true,
};

export function linesToEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const i = trimmed.indexOf('=');
    if (i <= 0) continue;
    out[trimmed.slice(0, i).trim()] = trimmed.slice(i + 1);
  }
  return out;
}

export function envToLines(env: Record<string, string>): string {
  return Object.entries(env)
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');
}

export function textToLabels(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const pair of text.split(',')) {
    const i = pair.indexOf('=');
    if (i <= 0) continue;
    const key = pair.slice(0, i).trim();
    const value = pair.slice(i + 1).trim();
    if (key && value) out[key] = value;
  }
  return out;
}

export function labelsToText(labels: Record<string, string> | undefined): string {
  return Object.entries(labels ?? {})
    .map(([k, v]) => `${k}=${v}`)
    .join(', ');
}

export function toDraft(job: ScheduledJobView): JobDraft {
  const [a, b, ...rest] = job.command;
  const shellWrapped = a === 'sh' && b === '-c' && rest.length === 1;
  return {
    name: job.name,
    schedule: job.schedule,
    kind: job.kind,
    image: job.image ?? '',
    serviceRef: job.serviceRef ?? '',
    command: shellWrapped ? (rest[0] ?? '') : job.command.join(' '),
    env: envToLines(job.env),
    runOnLabels: labelsToText(job.runOn.labels),
    timeoutMin: Math.max(1, Math.round(job.timeoutMs / 60_000)),
    retries: job.retries,
    alertOnFailure: job.alertOnFailure,
  };
}

export function toInput(draft: JobDraft): CreateScheduledJobInput {
  const labels = textToLabels(draft.runOnLabels);
  return {
    name: draft.name.trim(),
    schedule: draft.schedule.trim(),
    kind: draft.kind,
    ...(draft.kind === 'image' ? { image: draft.image.trim() } : {}),
    ...(draft.kind === 'service-exec' ? { serviceRef: draft.serviceRef.trim() } : {}),
    command: draft.command.trim() ? ['sh', '-c', draft.command.trim()] : [],
    env: linesToEnv(draft.env),
    runOn: Object.keys(labels).length > 0 ? { labels } : {},
    timeoutMs: Math.max(1, draft.timeoutMin) * 60_000,
    retries: draft.retries,
    alertOnFailure: draft.alertOnFailure,
    enabled: true,
  };
}
