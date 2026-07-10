/**
 * The swarmy-agent TUI — what an operator gets by typing `swarmy-agent` on an
 * interactive terminal. Four tabs:
 *
 *   [1] Overview  — the doctor ladder, live (re-runs every 5s); ↑↓ + Enter for
 *                   detail, `f` applies the selected check's fix (green/yellow)
 *   [2] Workloads — containers grouped by stack (pure Docker labels — works
 *                   with the controller fully dark)
 *   [3] Logs      — live agent journal tail
 *   [4] Backup    — pick a stack → export a rescue tarball, right here
 *
 * Built on @opentui/core (imperative API). Loaded via dynamic import from
 * main.ts so a missing/incompatible native lib degrades to plain `status` +
 * a hint instead of breaking the binary.
 */
import {
  BoxRenderable,
  SelectRenderable,
  SelectRenderableEvents,
  TextRenderable,
  createCliRenderer,
  type KeyEvent,
  type SelectOption,
} from '@opentui/core';
import { DockerClient } from '@swarmy/core/docker';
import { env } from '../env';
import { versionInfo } from '../version';
import { runChecks, type CheckResult, type DoctorReport } from './checks';
import { daemonStatus } from './context';

type Tab = 'overview' | 'workloads' | 'logs' | 'backup';

const STATUS_COLOR: Record<CheckResult['status'], string> = {
  ok: '#22c55e',
  warn: '#eab308',
  fail: '#ef4444',
  skip: '#6b7280',
};
const STATUS_GLYPH: Record<CheckResult['status'], string> = { ok: '●', warn: '●', fail: '●', skip: '○' };

export async function runTui(): Promise<void> {
  const renderer = await createCliRenderer({ exitOnCtrlC: false });
  const docker = new DockerClient(env.DOCKER_SOCKET);
  const v = versionInfo();

  let tab: Tab = 'overview';
  let report: DoctorReport | null = null;
  let fixing = false;
  let logProc: ReturnType<typeof Bun.spawn> | null = null;
  let logLines: string[] = [];
  let exporting = false;
  let disposed = false;
  const timers: ReturnType<typeof setInterval>[] = [];

  // ── static frame ──────────────────────────────────────────────────────────
  const root = new BoxRenderable(renderer, {
    id: 'root',
    flexDirection: 'column',
    width: '100%',
    height: '100%',
  });
  renderer.root.add(root);

  const header = new TextRenderable(renderer, {
    id: 'header',
    content: ` swarmy-agent v${v.version} — starting…`,
    fg: '#e2e8f0',
    bg: '#1e293b',
    width: '100%',
  });
  root.add(header);

  const tabBar = new TextRenderable(renderer, { id: 'tabs', content: '', fg: '#94a3b8', width: '100%' });
  root.add(tabBar);

  const content = new BoxRenderable(renderer, {
    id: 'content',
    flexDirection: 'column',
    flexGrow: 1,
    width: '100%',
  });
  root.add(content);

  const footer = new TextRenderable(renderer, {
    id: 'footer',
    content: ' 1-4 tabs · ↑↓ navigate · enter detail · f fix · r refresh · q quit',
    fg: '#64748b',
    width: '100%',
  });
  root.add(footer);

  // ── overview tab ──────────────────────────────────────────────────────────
  const checkList = new SelectRenderable(renderer, {
    id: 'checks',
    width: '100%',
    flexGrow: 1,
    options: [{ name: 'Running checks…', description: '' }],
    showDescription: true,
  });
  const detailText = new TextRenderable(renderer, { id: 'detail', content: '', fg: '#94a3b8', width: '100%' });

  // ── workloads tab ─────────────────────────────────────────────────────────
  const workloadsText = new TextRenderable(renderer, { id: 'workloads', content: 'loading…', fg: '#e2e8f0', width: '100%' });

  // ── logs tab ──────────────────────────────────────────────────────────────
  const logsText = new TextRenderable(renderer, { id: 'logs', content: 'starting journal tail…', fg: '#cbd5e1', width: '100%' });

  // ── backup tab ────────────────────────────────────────────────────────────
  const backupList = new SelectRenderable(renderer, {
    id: 'backup-stacks',
    width: '100%',
    flexGrow: 1,
    options: [{ name: 'scanning stacks…', description: '' }],
    showDescription: true,
  });
  const backupStatus = new TextRenderable(renderer, { id: 'backup-status', content: '', fg: '#94a3b8', width: '100%' });

  function renderTabBar(): void {
    const names: [Tab, string][] = [
      ['overview', '1 Overview'],
      ['workloads', '2 Workloads'],
      ['logs', '3 Logs'],
      ['backup', '4 Backup'],
    ];
    tabBar.content = ' ' + names.map(([t, label]) => (t === tab ? `[${label}]` : ` ${label} `)).join('  ');
  }

  // Mount every tab's renderables once; switching tabs toggles visibility
  // (visible=false also removes from layout — cheap and state-preserving).
  const tabRenderables: Record<Tab, Array<{ visible: boolean; focus?: () => void }>> = {
    overview: [checkList, detailText],
    workloads: [workloadsText],
    logs: [logsText],
    backup: [backupList, backupStatus],
  };
  for (const r of [checkList, detailText, workloadsText, logsText, backupList, backupStatus]) {
    content.add(r);
    r.visible = false;
  }

  function mountTab(): void {
    for (const [name, renderables] of Object.entries(tabRenderables) as [Tab, (typeof tabRenderables)[Tab]][]) {
      for (const r of renderables) r.visible = name === tab;
    }
    if (tab === 'overview') {
      checkList.focus();
    } else if (tab === 'logs') {
      startLogTail();
    } else if (tab === 'backup') {
      backupList.focus();
      void refreshBackupStacks();
    }
    if (tab !== 'logs') stopLogTail();
    renderTabBar();
  }

  // ── data refreshers ───────────────────────────────────────────────────────
  async function refreshHeader(): Promise<void> {
    const d = await daemonStatus();
    const link = d
      ? d.connected
        ? `connected · node ${d.nodeId ?? '?'}`
        : d.lastAuthReject
          ? `AUTH REJECTED ${d.lastAuthReject.code}`
          : 'dialing…'
      : 'daemon DOWN';
    header.content = ` swarmy-agent v${v.version} · ${report?.hostname ?? ''} · ${link}`;
  }

  async function refreshChecks(): Promise<void> {
    if (fixing) return;
    report = await runChecks();
    const selected = checkList.getSelectedIndex();
    checkList.options = report.checks.map((c) => ({
      name: `${STATUS_GLYPH[c.status]} ${c.title}`,
      description: c.detail,
    }));
    if (selected >= 0 && selected < report.checks.length) checkList.setSelectedIndex(selected);
    renderDetail();
    void refreshHeader();
  }

  function renderDetail(): void {
    const c = report?.checks[checkList.getSelectedIndex()];
    if (!c) {
      detailText.content = '';
      return;
    }
    const fix = c.fix && c.status !== 'ok' && c.status !== 'skip' ? `\n  fix available (press f): ${c.fix.title}` : '';
    detailText.content = `\n ${c.title}: ${c.detail}${c.hint ? `\n  ${c.hint.replaceAll('\n', '\n  ')}` : ''}${fix}`;
    detailText.fg = STATUS_COLOR[c.status];
  }

  async function applySelectedFix(): Promise<void> {
    const c = report?.checks[checkList.getSelectedIndex()];
    if (!c?.fix || fixing || c.status === 'ok' || c.status === 'skip') return;
    fixing = true;
    detailText.content = `\n ↻ applying: ${c.fix.title}…`;
    try {
      const outcome = await c.fix.apply();
      detailText.content = `\n ✓ ${outcome} — re-checking…`;
    } catch (err) {
      detailText.content = `\n ✗ fix failed: ${err instanceof Error ? err.message : err}`;
    }
    fixing = false;
    await refreshChecks();
  }

  async function refreshWorkloads(): Promise<void> {
    if (tab !== 'workloads') return;
    try {
      const containers = await docker.listContainers(true);
      const byStack = new Map<string, typeof containers>();
      for (const c of containers) {
        const stack = c.labels?.['com.docker.stack.namespace'] ?? '(no stack)';
        byStack.set(stack, [...(byStack.get(stack) ?? []), c]);
      }
      const lines: string[] = [''];
      for (const [stack, cs] of [...byStack.entries()].sort(([a], [b]) => a.localeCompare(b))) {
        lines.push(` ${stack} — ${cs.filter((c) => c.state === 'running').length}/${cs.length} running`);
        for (const c of cs) {
          const dot = c.state === 'running' ? '●' : '○';
          lines.push(`   ${dot} ${c.name.slice(0, 44).padEnd(46)} ${c.state.padEnd(10)} ${c.status}`);
        }
        lines.push('');
      }
      workloadsText.content = lines.join('\n') || '\n no containers';
    } catch (err) {
      workloadsText.content = `\n docker unavailable: ${err instanceof Error ? err.message : err}`;
    }
  }

  function startLogTail(): void {
    if (logProc) return;
    logLines = [];
    try {
      logProc = Bun.spawn(['journalctl', '-u', 'swarmy-agent.service', '-f', '-n', '40', '--no-pager', '-o', 'cat'], {
        stdout: 'pipe',
        stderr: 'ignore',
      });
      void (async () => {
        const reader = (logProc!.stdout as ReadableStream<Uint8Array>).getReader();
        const decoder = new TextDecoder();
        let buf = '';
        while (true) {
          const { done, value } = await reader.read().catch(() => ({ done: true, value: undefined }) as const);
          if (done || disposed) break;
          buf += decoder.decode(value, { stream: true });
          const parts = buf.split('\n');
          buf = parts.pop() ?? '';
          logLines.push(...parts);
          if (logLines.length > 500) logLines = logLines.slice(-500);
          if (tab === 'logs') {
            const visible = Math.max(5, (process.stdout.rows || 24) - 5);
            logsText.content = '\n' + logLines.slice(-visible).map((l) => ` ${l}`).join('\n');
          }
        }
      })();
    } catch {
      logsText.content = '\n journalctl unavailable (container backend?) — try: docker logs -f swarmy-agent';
    }
  }

  function stopLogTail(): void {
    logProc?.kill();
    logProc = null;
  }

  interface StackChoice {
    stack: string;
    volumes: number;
  }
  let backupChoices: StackChoice[] = [];

  async function refreshBackupStacks(): Promise<void> {
    try {
      const containers = await docker.listContainers(true);
      const volumesByStack = new Map<string, Set<string>>();
      for (const c of containers) {
        const stack = c.labels?.['com.docker.stack.namespace'];
        if (!stack) continue;
        const set = volumesByStack.get(stack) ?? new Set<string>();
        volumesByStack.set(stack, set);
      }
      // Count volumes per stack via the volume label (cheap, offline).
      const vols = (await docker.docker.listVolumes({})) as {
        Volumes?: { Name: string; Labels: Record<string, string> | null }[];
      };
      for (const vol of vols.Volumes ?? []) {
        const stack = vol.Labels?.['com.docker.stack.namespace'];
        if (!stack) continue;
        const set = volumesByStack.get(stack) ?? new Set<string>();
        set.add(vol.Name);
        volumesByStack.set(stack, set);
      }
      backupChoices = [...volumesByStack.entries()].map(([stack, set]) => ({ stack, volumes: set.size }));
      backupList.options = backupChoices.length
        ? backupChoices.map((s) => ({
            name: s.stack,
            description: `${s.volumes} named volume(s) — Enter exports a rescue tarball`,
          }))
        : [{ name: 'no stacks on this node', description: 'deploy something first, or use `swarmy-agent backup export --volumes …`' }];
      backupStatus.content = ' Exports land in /var/lib/swarmy/exports/ — restore with `swarmy-agent backup restore`.';
    } catch (err) {
      backupList.options = [{ name: 'docker unavailable', description: String(err instanceof Error ? err.message : err) }];
    }
  }

  async function runExport(choice: StackChoice): Promise<void> {
    if (exporting) return;
    exporting = true;
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const out = `/var/lib/swarmy/exports/${choice.stack}-${stamp}.tar.gz`;
    backupStatus.content = ` ↻ exporting ${choice.stack} → ${out} …`;
    try {
      // Same code path as `swarmy-agent backup export --stack <s> --to <out>`,
      // run as a subprocess: backupCommand() exits the process on failure,
      // which must never take the TUI down with it.
      const proc = Bun.spawn(
        [process.execPath, 'backup', 'export', '--stack', choice.stack, '--to', out],
        { stdout: 'pipe', stderr: 'pipe' },
      );
      const [stdout, stderr] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ]);
      const code = await proc.exited;
      backupStatus.content =
        code === 0
          ? ` ✓ exported ${choice.stack} → ${out}`
          : ` ✗ export failed: ${(stderr || stdout).trim().split('\n').at(-1) ?? `exit ${code}`}`;
    } catch (err) {
      backupStatus.content = ` ✗ export failed: ${err instanceof Error ? err.message : err}`;
    }
    exporting = false;
  }

  // ── events ────────────────────────────────────────────────────────────────
  checkList.on(SelectRenderableEvents.SELECTION_CHANGED, () => renderDetail());
  checkList.on(SelectRenderableEvents.ITEM_SELECTED, () => renderDetail());
  backupList.on(SelectRenderableEvents.ITEM_SELECTED, (index: number, _option: SelectOption) => {
    const choice = backupChoices[index];
    if (choice) void runExport(choice);
  });

  renderer.keyInput.on('keypress', (key: KeyEvent) => {
    if (key.name === 'q' || (key.ctrl && key.name === 'c')) {
      dispose();
      return;
    }
    if (key.name === '1') tab = 'overview';
    else if (key.name === '2') tab = 'workloads';
    else if (key.name === '3') tab = 'logs';
    else if (key.name === '4') tab = 'backup';
    else if (key.name === 'r') {
      void refreshChecks();
      void refreshWorkloads();
      return;
    } else if (key.name === 'f' && tab === 'overview') {
      void applySelectedFix();
      return;
    } else {
      return;
    }
    mountTab();
    void refreshWorkloads();
  });

  function dispose(): void {
    disposed = true;
    for (const t of timers) clearInterval(t);
    stopLogTail();
    renderer.destroy();
    process.exit(0);
  }

  // ── boot ──────────────────────────────────────────────────────────────────
  renderTabBar();
  mountTab();
  await refreshChecks();
  timers.push(setInterval(() => void refreshChecks(), 5_000));
  timers.push(setInterval(() => void refreshWorkloads(), 4_000));
}
