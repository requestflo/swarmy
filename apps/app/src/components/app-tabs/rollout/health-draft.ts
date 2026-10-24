import { applyHealthcheckEdit, type ServiceHealthcheckInput, type SpecHealthcheck } from '@swarmy/core';

/**
 * The health-check form (board AppRollout, Controls): the live check as
 * editable strings, and the edit Save sends — only what changed, so an
 * untouched probe is never rewritten. Durations are seconds; blank means
 * Docker's default. PURE — unit-tested in health-draft.test.ts.
 */

export type AskKind = 'http' | 'command' | 'off';

export interface HealthForm {
  ask: AskKind;
  path: string;
  port: string;
  command: string;
  interval: string;
  timeout: string;
  retries: string;
  start: string;
}

const LOCAL_URL = /https?:\/\/(?:localhost|127\.0\.0\.1)(?::(\d+))?(\/[^\s'"]*)?/;
const sec = (ns: number | undefined): string => (ns ? String(Math.round(ns / 1e7) / 100) : '');

/** The live check as a form. A service with no check starts as "GET /health" on its first port. */
export function formOf(hc: SpecHealthcheck | undefined, port?: number): HealthForm {
  const times = { interval: sec(hc?.intervalNs), timeout: sec(hc?.timeoutNs), retries: hc?.retries ? String(hc.retries) : '', start: sec(hc?.startPeriodNs) };
  const blank = { path: '/health', port: port ? String(port) : '', command: '' };
  if (hc?.disable) return { ask: 'off', ...blank, ...times };
  const test = hc?.test ?? [];
  const command = (test[0] === 'CMD' || test[0] === 'CMD-SHELL' ? test.slice(1) : test).join(' ');
  const url = LOCAL_URL.exec(command);
  if (url) return { ask: 'http', path: url[2] ?? '/', port: url[1] ?? '80', command, ...times };
  return command ? { ask: 'command', ...blank, command, ...times } : { ask: 'http', ...blank, ...times };
}

const SECONDS: [keyof HealthForm, 'intervalSeconds' | 'timeoutSeconds' | 'startPeriodSeconds', string][] = [
  ['interval', 'intervalSeconds', 'Every'],
  ['timeout', 'timeoutSeconds', 'Give up after'],
  ['start', 'startPeriodSeconds', 'Grace on start'],
];

export interface HealthEdit {
  /** null = nothing to save. */
  edit: ServiceHealthcheckInput | null;
  /** A plain-words reason Save is off. */
  error: string | null;
}

/**
 * The edit for `services.update`. `mustAsk`: the service has no check of its
 * own yet (none, or only the image's), so the probe is always sent.
 */
export function editOf(base: HealthForm, f: HealthForm, mustAsk: boolean): HealthEdit {
  if (f.ask === 'off') return { edit: base.ask === 'off' && !mustAsk ? null : { disable: true }, error: null };
  const edit: ServiceHealthcheckInput = {};
  const askChanged = mustAsk || base.ask !== f.ask || (f.ask === 'http' ? f.path !== base.path || f.port !== base.port : f.command !== base.command);
  if (askChanged && f.ask === 'http') {
    const port = Number(f.port);
    if (!/^\/[^\s'"`\\]*$/.test(f.path.trim())) return { edit: null, error: 'The path starts with / and has no spaces or quotes.' };
    if (!Number.isInteger(port) || port < 1 || port > 65535) return { edit: null, error: 'Say which port the app listens on inside its container.' };
    edit.http = { path: f.path.trim(), port };
  } else if (askChanged) {
    if (!f.command.trim()) return { edit: null, error: 'Type the command that exits 0 when the app is fine.' };
    edit.test = ['CMD-SHELL', f.command.trim()];
  }
  for (const [key, field, label] of SECONDS) {
    if (f[key] === base[key]) continue;
    const n = f[key].trim() === '' ? 0 : Number(f[key]);
    if (!Number.isFinite(n) || n < 0 || n > 86_400) return { edit: null, error: `${label} is a number of seconds.` };
    edit[field] = n;
  }
  if (f.retries !== base.retries) {
    const n = f.retries.trim() === '' ? 0 : Number(f.retries);
    if (!Number.isInteger(n) || n < 0 || n > 100) return { edit: null, error: 'Unhealthy after is a whole number of misses.' };
    edit.retries = n;
  }
  return { edit: Object.keys(edit).length ? edit : null, error: null };
}

/** The check after Save, for the Code view; the live one when the edit can't apply. */
export function previewOf(live: SpecHealthcheck | undefined, edit: ServiceHealthcheckInput | null): SpecHealthcheck | undefined {
  if (!edit) return live;
  try {
    return applyHealthcheckEdit(live, edit);
  } catch {
    return live;
  }
}
