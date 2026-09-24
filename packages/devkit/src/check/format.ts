import type { CheckIssue, CheckReport } from './check';
import { describeDetection } from './detect';

const MARK: Record<CheckIssue['severity'], string> = { error: 'error', warning: 'warn ', info: 'note ' };

function where(i: CheckIssue): string {
  if (!i.file) return '';
  return i.line ? `${i.file}:${i.line}${i.col ? `:${i.col}` : ''} ` : `${i.file} `;
}

/** The terminal rendering of a check report (no colour; the CLI adds it). */
export function formatCheckReport(r: CheckReport): string {
  const out: string[] = [];
  const mode =
    r.mode === 'swarmy.yaml'
      ? `swarmy.yaml (${r.configPath})`
      : r.mode === 'compose'
        ? `compose file (${r.configPath})`
        : r.mode === 'dockerfile'
          ? 'Dockerfile, no swarmy.yaml'
          : r.mode === 'detected'
            ? 'detected stack, no swarmy.yaml or Dockerfile'
            : 'nothing swarmy recognises';
  out.push(`Found: ${mode}`);
  if (r.app) out.push(`App:   ${r.app}${r.stack && r.stack !== r.app ? ` (stack ${r.stack})` : ''}`);

  if (r.services.length) {
    out.push('', 'Services:');
    for (const s of r.services) {
      const how =
        s.source === 'image'
          ? `image ${s.from}`
          : s.source === 'dockerfile'
            ? `Dockerfile ${s.dockerfile ?? `${s.from}/Dockerfile`}`
            : s.source === 'compose'
              ? s.from
              : `Railpack ${s.from}${s.detected ? ` — ${describeDetection(s.detected)}` : ''}`;
      const extra = [s.port ? `port ${s.port}` : '', s.domains.length ? s.domains.join(', ') : ''].filter(Boolean).join(' · ');
      out.push(`  ${s.name.padEnd(14)} ${how}${extra ? `  (${extra})` : ''}`);
    }
  }
  if (r.resources.length) {
    out.push('', 'Resources:');
    for (const x of r.resources) out.push(`  ${x.name.padEnd(14)} ${x.detail}`);
  }
  if (r.plan.length) {
    out.push('', 'What swarmy will do:');
    r.plan.forEach((p, n) => out.push(`  ${n + 1}. ${p}`));
  }
  if (r.issues.length) {
    out.push('', 'Problems:');
    for (const i of r.issues) out.push(`  ${MARK[i.severity]} ${where(i)}${i.message}`);
  }
  if (r.suggestedConfig) {
    out.push('', 'Suggested swarmy.yaml:', ...r.suggestedConfig.trimEnd().split('\n').map((l) => `  ${l}`));
  }
  const errors = r.issues.filter((i) => i.severity === 'error').length;
  const warnings = r.issues.filter((i) => i.severity === 'warning').length;
  out.push(
    '',
    r.ok
      ? `✓ Ready for swarmy${warnings ? ` (${warnings} warning${warnings === 1 ? '' : 's'})` : ''}.`
      : `✗ ${errors} problem${errors === 1 ? '' : 's'} to fix before this deploys.`,
  );
  return out.join('\n');
}
