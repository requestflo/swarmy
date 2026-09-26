import { API_BASE, curl, type CodeTab } from '@/components/calm';

/**
 * Code depth: use a key (curl, Terraform), mint one over REST, the CLI and
 * agents. Real paths and resources only: POST /api-keys + POST /stacks are in
 * openapi.json; `swarmy_api_key` / `swarmy_stack` are the provider's resources.
 */
export function apiCode(app = 'storefront'): CodeTab[] {
  const origin = API_BASE.replace(/\/api\/v1$/, '');
  return [
    {
      label: 'curl',
      code: `# ship ${app} with a Deploy key (202 Accepted; poll the deploy)\ncurl -X POST ${API_BASE}/stacks \\\n  -H "Authorization: Bearer $SWARMY_TOKEN" \\\n  -H "Idempotency-Key: $GITHUB_SHA" \\\n  -H "Content-Type: application/json" \\\n  -d '{"name":"${app}","compose_source":"…"}'\n\n# mint a key limited to ${app}\n${curl('POST', '/api-keys', { name: 'github-actions', preset: 'deploy', stack_names: [app], expiry: '90d' })}`,
    },
    {
      label: 'Terraform',
      code: `provider "swarmy" {\n  endpoint = "${origin}" # or SWARMY_ENDPOINT\n  # api_key from SWARMY_API_KEY\n}\n\nresource "swarmy_api_key" "ci" {\n  name   = "github-actions"\n  scopes = ["read", "deploy"] # the Deploy preset\n  # no per-app limit or expiry in the provider yet: set those over REST\n}\n\nresource "swarmy_stack" "${app}" {\n  name           = "${app}"\n  compose_source = file("compose.yaml")\n}`,
    },
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
  ];
}
