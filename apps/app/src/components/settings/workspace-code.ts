import { restExchange, type CodeTab } from '@/components/calm';
import type { OrgInfo } from './workspace-section';

/** Code depth: who you are to the CLI and the API. */
export function workspaceCode(org: OrgInfo, email: string | null): CodeTab[] {
  return [
    {
      label: 'CLI',
      code: `swarmy login          # opens this dashboard to approve the device\nswarmy whoami\n\n# controller  https://swarmy.example.com\n# user        ${email ?? 'you'}\n# org         ${org.id}\n# role        ${org.role}`,
    },
    {
      label: 'REST',
      code: restExchange('GET', '/me', { org_id: org.id, user: { id: '…', email, name: null }, role: org.role, credential: { kind: 'api_key', id: '…', scopes: ['read', 'write'] } }),
    },
  ];
}
