import { API_BASE, curl, type CodeTab } from '@/components/calm';

/** Code depth: install and sign in to the CLI, wire an agent, and the key API over REST. Real commands only. */
export function apiCode(): CodeTab[] {
  const origin = API_BASE.replace(/\/api\/v1$/, '');
  return [
    {
      label: 'CLI',
      code: `curl -fsSL ${origin}/install/cli.sh | sh\nswarmy login --controller ${origin}\nswarmy whoami\nswarmy deploy\nswarmy logs web -f`,
    },
    {
      label: 'Claude Code',
      code: `# local, with the CLI's login\nclaude mcp add swarmy -- swarmy mcp --read-only\n\n# remote, with an API key\nclaude mcp add --transport http swarmy ${origin}/mcp \\\n  --header "Authorization: Bearer swk_…"`,
    },
    {
      label: 'Cursor',
      code: JSON.stringify({ mcpServers: { swarmy: { command: 'swarmy', args: ['mcp'] } } }, null, 2),
    },
    {
      label: 'REST',
      code: `${curl('GET', '/api-keys')}\n\n${curl('POST', '/api-keys', { name: 'ci-terraform', scopes: ['read', 'write'] })}`,
    },
  ];
}
