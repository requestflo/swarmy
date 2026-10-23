/**
 * The CLI & MCP board (67), in real commands only: the CLI's own command
 * table (apps/cli/src/args.ts), the install script the controller serves
 * (GET /install/cli.sh, apps/api/src/devx.ts), and the tools the MCP server
 * registers (packages/devkit/src/mcp/server.ts — READ_TOOLS, MUTATING_TOOLS).
 */

/** `curl … | sh` then `swarmy login` against this controller. */
export function cliInstall(origin: string): string {
  return `$ curl -fsSL ${origin}/install/cli.sh | sh\n$ swarmy login --controller ${origin}`;
}

export const CLI_COMMANDS: Array<{ cmd: string; say: string }> = [
  { cmd: 'swarmy check', say: 'will this repo deploy? checked on your machine' },
  { cmd: 'swarmy deploy', say: 'build and roll out the linked app’s branch' },
  { cmd: 'swarmy logs web -f', say: 'follow a service’s logs' },
  { cmd: 'swarmy env pull', say: 'write .env from your app, secrets held back' },
  { cmd: 'swarmy run -- npm test', say: 'run a command with your app’s variables' },
  { cmd: 'swarmy status', say: 'environments, services and the last deploy' },
  { cmd: 'swarmy open', say: 'open the app in your browser' },
];

/** Tools every connection gets, then the ones only a `write`-scoped credential gets. */
export const MCP_READ_TOOLS: Array<[string, string]> = [
  ['check_repo', 'check a repo'],
  ['list_apps', 'list apps'],
  ['app_status', 'app status'],
  ['logs', 'logs'],
  ['env', 'a service’s variables'],
  ['explain_error', 'explain an error'],
];
/** Registered for a key with the `deploy` scope (or `write`), like their REST routes. */
export const MCP_DEPLOY_TOOLS: Array<[string, string]> = [
  ['deploy', 'deploy'],
  ['trial_deploy', 'trial preview deploy'],
  ['env_set', 'change variables'],
];

/** Registered only for a key with the `write` scope (the Admin preset). */
export const MCP_ADMIN_TOOLS: Array<[string, string]> = [
  ['telemetry_toggle', 'telemetry on/off'],
  ['remove_stack', 'remove an app environment'],
];

export type McpClient = 'claude' | 'cursor' | 'vscode' | 'http';

export const MCP_CLIENTS: Array<{ value: McpClient; label: string }> = [
  { value: 'claude', label: 'Claude Code' },
  { value: 'cursor', label: 'Cursor' },
  { value: 'vscode', label: 'VS Code' },
  { value: 'http', label: 'Any client' },
];

const STDIO = { command: 'swarmy', args: ['mcp', '--read-only'] };

/** How each client adds swarmy: locally over stdio with the CLI's sign-in, or remotely at `<controller>/mcp` with a key. */
export function mcpConfig(client: McpClient, origin: string): string {
  if (client === 'claude')
    return `# on your machine, with the CLI's sign-in\nclaude mcp add swarmy -- swarmy mcp --read-only\n\n# or remote, with an API key\nclaude mcp add --transport http swarmy ${origin}/mcp \\\n  --header "Authorization: Bearer $SWARMY_KEY"`;
  if (client === 'cursor') return `// .cursor/mcp.json\n${JSON.stringify({ mcpServers: { swarmy: STDIO } }, null, 2)}`;
  if (client === 'vscode') return `// .vscode/mcp.json\n${JSON.stringify({ servers: { swarmy: { type: 'stdio', ...STDIO } } }, null, 2)}`;
  return `# Streamable HTTP, for any MCP client\nurl:    ${origin}/mcp\nheader: Authorization: Bearer swk_…   # an API key or an OAuth token from swarmy`;
}
