import * as React from 'react';
import { CodeView, toYaml } from '@/components/calm';
import type { EmailOverviewData } from './use-email';

/** Email as code: the app's `email:` key, what it binds, and the HTTP send API. */
export function EmailCode({ overview: o }: { overview: EmailOverviewData }): React.JSX.Element {
  const from = o.domains.find((d) => d.verifiedAt && !d.isSystem)?.domain ?? o.domains.find((d) => d.verifiedAt)?.domain ?? 'example.com';
  const yaml = `# swarmy.yaml — send mail from this app\n${toYaml({ email: { from: `noreply@${from}`, services: ['web', 'worker'] } })}\n\n# every bound service gets, on deploy:\n#   SMTP_HOST=${o.mta.host} SMTP_PORT=${o.mta.port} SMTP_USER SMTP_FROM EMAIL_FROM EMAIL_API_URL\n#   SMTP_PASS, EMAIL_API_KEY  (secrets, never in the spec)`;
  const send = [
    `curl -X POST ${o.apiUrl}/send \\`,
    '  -H "Authorization: Bearer $EMAIL_API_KEY" \\',
    '  -H "Content-Type: application/json" \\',
    `  -d '${JSON.stringify({ from: `noreply@${from}`, to: 'ada@example.com', subject: 'Welcome', text: 'Hi Ada' })}'`,
  ].join('\n');
  const dns = o.domains
    .map((d) => `; ${d.domain}\n${d.records.map((r) => `${r.name}. IN ${r.type} "${r.value.length > 80 ? `${r.value.slice(0, 77)}...` : r.value}"`).join('\n')}`)
    .join('\n\n');
  return (
    <CodeView
      tabs={[
        { label: 'swarmy.yaml', code: yaml },
        { label: 'Send API', code: send },
        { label: 'DNS records', code: dns || '; no sending domains yet' },
      ]}
      source="yaml"
    />
  );
}
