import { fmt, say } from './context';

export function helpCommand(): void {
  say(`
${fmt.bold('swarmy-agent')} — swarmy node agent & diagnostics CLI

${fmt.bold('USAGE')}
  swarmy-agent [command] [flags]

  With no command: runs the daemon when detached (systemd/docker), or shows
  node status on an interactive terminal.

${fmt.bold('DIAGNOSE')}
  status  [--json]            one-glance node summary
  doctor  [--json|--fix|--yes] full health ladder; --fix applies safe repairs
  logs    [-f] [-n N] [--container X]   agent journal / container logs
  support-bundle [--out path] redacted diagnostics tarball for sharing

${fmt.bold('RECOVER')}
  reconnect                   force an immediate controller redial
  rejoin  [--force] [--yes]   swarm-membership repair ladder
  mesh    status|ping <ip>|join|leave   local mesh operations
  backup  export|push|restore|list      rescue backups (works controller-down)

${fmt.bold('LIFECYCLE')}
  daemon                      run the agent daemon (what systemd invokes)
  update                      self-update from the controller's manifest
  reset   [--keep-data]       remove this node's agent state (typed confirm)
  version                     print version and exit

${fmt.bold('REPAIR-MODE ONE-LINER')}
  Re-running the dashboard's "Add a node" one-liner on an already-enrolled box
  is always safe: it detects the existing install, refreshes credentials, and
  runs ${fmt.cyan('doctor --repair')} instead of double-enrolling.
`);
}
