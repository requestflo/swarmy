/**
 * Step runner + reports: each scenario is a named step with a status
 * (pass/fail/skip), a duration, and its log lines. Written as JSON and JUnit
 * XML, and printed as a human summary table.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { color, redact, setLogSink } from './util';

export type Status = 'pass' | 'fail' | 'skip';

export interface StepResult {
  id: string;
  title: string;
  status: Status;
  durationMs: number;
  detail: string;
  log: string[];
  startedAt: string;
}

/** Throw from a step to mark it skipped (feature flag off, prerequisite absent). */
export class Skip extends Error {}

export class Report {
  readonly results: StepResult[] = [];
  private readonly started = new Date();
  constructor(
    readonly meta: Record<string, string>,
  ) {}

  async step(id: string, title: string, fn: () => Promise<string | void>): Promise<StepResult> {
    const log: string[] = [];
    const t0 = Date.now();
    const startedAt = new Date().toISOString();
    process.stdout.write(color.bold(`\n── ${id} · ${title}`) + '\n');
    setLogSink((l) => log.push(l));
    let status: Status = 'pass';
    let detail = '';
    try {
      detail = (await fn()) ?? '';
    } catch (e) {
      if (e instanceof Skip) {
        status = 'skip';
        detail = e.message;
      } else {
        status = 'fail';
        detail = (e as Error).message ?? String(e);
      }
    } finally {
      setLogSink(null);
    }
    const r: StepResult = {
      id,
      title,
      status,
      durationMs: Date.now() - t0,
      detail: redact(detail),
      log,
      startedAt,
    };
    this.results.push(r);
    const tag = status === 'pass' ? color.green('PASS') : status === 'skip' ? color.yellow('SKIP') : color.red('FAIL');
    process.stdout.write(`${tag} ${id} (${fmt(r.durationMs)})${r.detail ? ` — ${r.detail}` : ''}\n`);
    return r;
  }

  get failed() {
    return this.results.filter((r) => r.status === 'fail').length;
  }

  write(dir: string) {
    mkdirSync(dir, { recursive: true });
    const totalMs = Date.now() - this.started.getTime();
    const json = {
      suite: 'swarmy-e2e-cluster',
      startedAt: this.started.toISOString(),
      durationMs: totalMs,
      meta: this.meta,
      summary: {
        pass: this.results.filter((r) => r.status === 'pass').length,
        fail: this.failed,
        skip: this.results.filter((r) => r.status === 'skip').length,
      },
      steps: this.results,
    };
    writeFileSync(join(dir, 'report.json'), JSON.stringify(json, null, 2));
    writeFileSync(join(dir, 'junit.xml'), this.junit(totalMs));
    writeFileSync(join(dir, 'summary.txt'), this.summary(false));
  }

  private junit(totalMs: number): string {
    const esc = (s: string) =>
      s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    const cases = this.results
      .map((r) => {
        const inner =
          r.status === 'fail'
            ? `<failure message="${esc(r.detail)}">${esc(r.log.join('\n'))}</failure>`
            : r.status === 'skip'
              ? `<skipped message="${esc(r.detail)}"/>`
              : `<system-out>${esc(r.log.join('\n'))}</system-out>`;
        return `    <testcase classname="swarmy.e2e.cluster" name="${esc(`${r.id} ${r.title}`)}" time="${(r.durationMs / 1000).toFixed(1)}">${inner}</testcase>`;
      })
      .join('\n');
    const skipped = this.results.filter((r) => r.status === 'skip').length;
    return `<?xml version="1.0" encoding="UTF-8"?>
<testsuites>
  <testsuite name="swarmy-e2e-cluster" tests="${this.results.length}" failures="${this.failed}" skipped="${skipped}" time="${(totalMs / 1000).toFixed(1)}" timestamp="${this.started.toISOString()}">
${cases}
  </testsuite>
</testsuites>
`;
  }

  summary(colored = true): string {
    const paint = (s: Status, t: string) =>
      !colored ? t : s === 'pass' ? color.green(t) : s === 'fail' ? color.red(t) : color.yellow(t);
    const w = Math.max(...this.results.map((r) => r.id.length), 4);
    const lines = [
      '',
      'swarmy cluster e2e — ' + Object.entries(this.meta).map(([k, v]) => `${k}=${v}`).join(' '),
      '',
      `  ${'STEP'.padEnd(w)}  RESULT  TIME     DETAIL`,
      ...this.results.map(
        (r) =>
          `  ${r.id.padEnd(w)}  ${paint(r.status, r.status.toUpperCase().padEnd(6))}  ${fmt(r.durationMs).padEnd(7)}  ${r.detail.split('\n')[0]!.slice(0, 160)}`,
      ),
      '',
      `  ${this.results.filter((r) => r.status === 'pass').length} passed, ${this.failed} failed, ${this.results.filter((r) => r.status === 'skip').length} skipped in ${fmt(Date.now() - this.started.getTime())}`,
      '',
    ];
    return lines.join('\n');
  }
}

export function fmt(ms: number): string {
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s`;
}
