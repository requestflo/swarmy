/**
 * `swarmy-agent doctor` — run the full check ladder and render it.
 *
 *   doctor            human output, exit 1 if anything failed
 *   doctor --json     machine output (support bundles, dashboard upload)
 *   doctor --fix      apply green fixes automatically, prompt for yellow
 *   doctor --yes      with --fix: also apply yellow fixes unprompted
 *   doctor --repair   fix mode used by the install one-liner's repair path:
 *                     green+yellow fixes auto-applied, then a re-check pass,
 *                     summary designed to be read in an install log
 */
import { runChecks, type CheckResult, type DoctorReport } from './checks';
import { confirmYesNo, fmt, GLYPH, say } from './context';

export async function doctorCommand(flags: Set<string>): Promise<void> {
  const json = flags.has('json');
  const repair = flags.has('repair');
  const fix = flags.has('fix') || repair;
  const autoYes = flags.has('yes') || repair;

  let report = await runChecks();

  if (fix) {
    const applied = await applyFixes(report, autoYes, json);
    if (applied > 0) {
      // Something changed — give services a beat to settle, then re-check so
      // the rendered report reflects the POST-fix world.
      await new Promise((r) => setTimeout(r, 2_000));
      report = await runChecks();
    }
  }

  if (json) {
    say(JSON.stringify(report, null, 2));
  } else {
    render(report, repair);
  }

  process.exit(report.checks.some((c) => c.status === 'fail') ? 1 : 0);
}

async function applyFixes(report: DoctorReport, autoYes: boolean, quiet: boolean): Promise<number> {
  let applied = 0;
  for (const check of report.checks) {
    if (!check.fix || check.status === 'ok' || check.status === 'skip') continue;
    const { fix } = check;
    if (fix.danger === 'yellow') {
      const go = await confirmYesNo(`Apply fix for ${check.title}: ${fix.title}?`, autoYes);
      if (!go) continue;
    }
    try {
      const outcome = await fix.apply();
      applied += 1;
      if (!quiet) say(`${fmt.cyan('↻')} ${check.title}: ${outcome}`);
    } catch (err) {
      if (!quiet) say(`${fmt.red('✗')} ${check.title}: fix failed — ${err instanceof Error ? err.message : err}`);
    }
  }
  return applied;
}

function render(report: DoctorReport, repair: boolean): void {
  say('');
  say(`${fmt.bold(`swarmy-agent doctor`)} ${fmt.dim(`— ${report.hostname}, v${report.version} (${report.commit})`)}`);
  say('');
  for (const check of report.checks) {
    say(renderRow(check));
    if (check.hint && check.status !== 'ok') {
      for (const line of check.hint.split('\n')) say(`     ${fmt.dim(line)}`);
    }
  }
  say('');
  const fails = report.checks.filter((c) => c.status === 'fail').length;
  const warns = report.checks.filter((c) => c.status === 'warn').length;
  if (fails === 0 && warns === 0) {
    say(fmt.green('✓ Everything looks healthy.'));
  } else if (fails === 0) {
    say(fmt.yellow(`⚠ Healthy with ${warns} warning${warns === 1 ? '' : 's'}.`));
  } else {
    say(fmt.red(`✗ ${fails} problem${fails === 1 ? '' : 's'} found${warns ? ` (+${warns} warning${warns === 1 ? '' : 's'})` : ''}.`));
    if (!repair) say(fmt.dim('  Try `swarmy-agent doctor --fix`, or re-run the install one-liner from the dashboard (repair mode).'));
  }
  say('');
}

function renderRow(check: CheckResult): string {
  const title = check.title.padEnd(20);
  return ` ${GLYPH[check.status]} ${title} ${check.detail}`;
}
