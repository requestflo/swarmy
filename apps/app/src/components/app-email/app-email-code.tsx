import { toYaml, withHeader, type CodeTab } from '@/components/calm';
import type { EmailOverviewData } from '@/components/email/use-email';
import type { EmailCredentialData } from './use-app-mail';

/** The app's Email tab as code: the `email:` key, what it binds, and one HTTP send. */
export function appEmailCode(stack: string, o: EmailOverviewData, creds: EmailCredentialData[]): CodeTab[] {
  const from = creds[0]?.domains[0] ?? o.domains.find((d) => d.verifiedAt)?.domain ?? 'example.com';
  const yaml = withHeader(
    `swarmy.yaml · ${stack} sends mail through swarmy`,
    [
      toYaml({ email: { from: `noreply@${from}` } }),
      '',
      '# every bound service gets, on deploy:',
      `#   SMTP_HOST=${o.mta.host} SMTP_PORT=${o.mta.port} SMTP_USER SMTP_FROM EMAIL_FROM EMAIL_API_URL`,
      '#   SMTP_PASS, EMAIL_API_KEY  (Docker secrets, never in the spec)',
      '# other names: MAIL_PASSWORD: ${{ email.password }}',
    ].join('\n'),
  );
  const send = [
    `curl -X POST ${o.apiUrl}/send \\`,
    '  -H "Authorization: Bearer $EMAIL_API_KEY" \\',
    '  -H "Content-Type: application/json" \\',
    `  -d '${JSON.stringify({ from: `noreply@${from}`, to: 'ada@example.com', subject: 'Welcome', text: 'Hi Ada' })}'`,
  ].join('\n');
  return [
    { label: 'swarmy.yaml', code: yaml },
    { label: 'Send API', code: send },
  ];
}
