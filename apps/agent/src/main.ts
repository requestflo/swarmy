/**
 * swarmy-agent binary entrypoint — CLI dispatch.
 *
 * Contract with the world:
 *   - systemd runs the binary with NO ARGS and no TTY → daemon (backwards
 *     compatible with every already-deployed unit; self-update swaps the
 *     binary without touching the unit file).
 *   - `--version` must print `swarmy-agent <v> (protocol <p>, commit <c>)` —
 *     the self-update flow probes a downloaded binary with exactly this.
 *   - An interactive terminal with no args gets the TUI (or status while the
 *     TUI is unavailable), because a human typing `swarmy-agent` is asking
 *     "how is this node?", not "become a daemon on my tty".
 *
 * Env bootstrap (/etc/swarmy/agent.env for interactive invocations) happens
 * inside env.ts itself — the one module that reads process.env — because the
 * compiled bundle's module evaluation order would race a load done here.
 */
const argv = process.argv.slice(2);
const cmd = argv[0];

// --version first: zero side effects, no env needed, used as a liveness probe.
if (cmd === '--version' || cmd === '-v' || cmd === 'version') {
  const { versionInfo } = await import('./version');
  const v = versionInfo();
  // eslint-disable-next-line no-console
  console.log(`swarmy-agent ${v.version} (protocol ${v.protocolVersion}, commit ${v.commit})`);
  process.exit(0);
}

const rest = argv.slice(1);

switch (cmd) {
  case undefined: {
    if (process.stdout.isTTY && process.stdin.isTTY) {
      // Interactive: the TUI. If its native renderer can't load on this box,
      // degrade to plain status instead of failing the binary.
      try {
        const { runTui } = await import('./cli/tui');
        await runTui();
      } catch (err) {
        const { statusCommand } = await import('./cli/status');
        const { say, fmt } = await import('./cli/context');
        say(fmt.dim(`(TUI unavailable: ${err instanceof Error ? err.message : err})`));
        await statusCommand(new Set());
        say(fmt.dim('  All commands: swarmy-agent help'));
      }
    } else {
      const { runDaemon } = await import('./daemon');
      await runDaemon();
    }
    break;
  }
  case 'daemon': {
    const { runDaemon } = await import('./daemon');
    await runDaemon();
    break;
  }
  case 'status': {
    const { statusCommand } = await import('./cli/status');
    const { parseFlags } = await import('./cli/context');
    await statusCommand(parseFlags(rest).flags);
    break;
  }
  case 'doctor': {
    const { doctorCommand } = await import('./cli/doctor');
    const { parseFlags } = await import('./cli/context');
    await doctorCommand(parseFlags(rest).flags);
    break;
  }
  case 'reconnect': {
    const { reconnectCommand } = await import('./cli/reconnect');
    await reconnectCommand();
    break;
  }
  case 'rejoin': {
    const { rejoinCommand } = await import('./cli/rejoin');
    const { parseFlags } = await import('./cli/context');
    const parsed = parseFlags(rest);
    await rejoinCommand(parsed.flags);
    break;
  }
  case 'mesh': {
    const { meshCommand } = await import('./cli/mesh-cli');
    const { parseFlags } = await import('./cli/context');
    const parsed = parseFlags(rest);
    await meshCommand(parsed.positional, parsed.flags, parsed.options);
    break;
  }
  case 'backup': {
    const { backupCommand } = await import('./cli/backup');
    const { parseFlags } = await import('./cli/context');
    const parsed = parseFlags(rest);
    await backupCommand(parsed.positional, parsed.flags, parsed.options);
    break;
  }
  case 'logs': {
    const { logsCommand } = await import('./cli/logs');
    const { parseFlags } = await import('./cli/context');
    await logsCommand(rest, parseFlags(rest).options);
    break;
  }
  case 'support-bundle': {
    const { supportBundleCommand } = await import('./cli/support-bundle');
    const { parseFlags } = await import('./cli/context');
    await supportBundleCommand(parseFlags(rest).options);
    break;
  }
  case 'update': {
    const { updateCommand } = await import('./cli/update-cli');
    await updateCommand();
    break;
  }
  case 'reset': {
    const { resetCommand } = await import('./cli/reset');
    const { parseFlags } = await import('./cli/context');
    await resetCommand(parseFlags(rest).flags);
    break;
  }
  case 'help':
  case '--help':
  case '-h': {
    const { helpCommand } = await import('./cli/help');
    helpCommand();
    break;
  }
  default: {
    // eslint-disable-next-line no-console
    console.error(`swarmy-agent: unknown command "${cmd}" — see \`swarmy-agent help\``);
    process.exit(1);
  }
}

