import { DOCKER_HEALTH_DEFAULTS } from '@swarmy/core';
import type { ServiceSpec } from '@swarmy/core/protocol';

/**
 * The health check, read off the live spec (board AppRollout): what swarmy
 * asks for, how often, and when a copy counts as unhealthy, in plain words.
 * A field the spec leaves out is Docker's own default, said as such.
 * PURE — unit-tested in health-model.test.ts.
 */

type Healthcheck = NonNullable<ServiceSpec['healthcheck']>;

/** Docker's defaults for a HEALTHCHECK field left unset — shared with the controller (@swarmy/core). */
export { DOCKER_HEALTH_DEFAULTS };

export interface HealthFact {
  label: string;
  value: string;
  /** True when this is Docker's default, not something the app set. */
  dflt: boolean;
}

export interface HealthWords {
  kind: 'none' | 'off' | 'check';
  /** "GET /health" · "runs pg_isready -U app" */
  ask: string;
  /** "on port 3000", when the probe names one. */
  askSub: string | null;
  facts: HealthFact[];
  /** The test as Docker stores it: `CMD wget -qO- http://localhost:3000/health`. */
  raw: string;
}

const URL_RE = /https?:\/\/[^\s'"]+/;

/** "10 s" · "2 min" · "1.5 s". */
export function secs(n: number): string {
  if (n >= 60 && n % 60 === 0) return `${n / 60} min`;
  return `${Math.round(n * 10) / 10} s`;
}

/** What the probe asks for: an HTTP GET when it fetches a URL, otherwise the command it runs. */
export function askWords(test: string[]): { ask: string; sub: string | null } {
  const cmd = (test[0] === 'CMD' || test[0] === 'CMD-SHELL' ? test.slice(1) : test).join(' ').trim();
  const url = URL_RE.exec(cmd)?.[0];
  if (url) {
    try {
      const u = new URL(url);
      return { ask: `GET ${u.pathname}${u.search}`, sub: u.port ? `on port ${u.port}` : null };
    } catch {
      /* not a URL after all: say the command */
    }
  }
  const short = cmd.length > 48 ? `${cmd.slice(0, 47)}…` : cmd;
  return { ask: short ? `runs ${short}` : 'no command', sub: null };
}

const fact = (label: string, ns: number | undefined, dflt: number): HealthFact =>
  ns === undefined || ns === 0 ? { label, value: dflt ? secs(dflt) : 'none', dflt: true } : { label, value: secs(ns / 1e9), dflt: false };

export function healthWords(hc: Healthcheck | undefined): HealthWords {
  const test = hc?.test ?? [];
  if (hc?.disable || test[0] === 'NONE') return { kind: 'off', ask: '', askSub: null, facts: [], raw: 'NONE' };
  if (!hc || test.length === 0) return { kind: 'none', ask: '', askSub: null, facts: [], raw: '' };
  const { ask, sub } = askWords(test);
  const retries = hc.retries || DOCKER_HEALTH_DEFAULTS.retries;
  return {
    kind: 'check',
    ask,
    askSub: sub,
    raw: test.join(' '),
    facts: [
      fact('Every', hc.intervalNs, DOCKER_HEALTH_DEFAULTS.intervalSec),
      fact('Give up after', hc.timeoutNs, DOCKER_HEALTH_DEFAULTS.timeoutSec),
      { label: 'Unhealthy after', value: `${retries} miss${retries === 1 ? '' : 'es'}`, dflt: !hc.retries },
      fact('Grace on start', hc.startPeriodNs, DOCKER_HEALTH_DEFAULTS.startSec),
    ],
  };
}
