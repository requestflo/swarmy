import * as React from 'react';
import { Link } from '@tanstack/react-router';
import { Section, SectionLink, Tech } from '@/components/calm';
import type { EmailOverviewData } from '@/components/email/use-email';
import type { EmailCredentialData } from './use-app-mail';

const SECRET = '•••••••• secret';

/**
 * Credentials (Email board): the login bound to this app and the variables
 * `email:` in swarmy.yaml sets on each bound service at deploy
 * (EMAIL_AUTO_ENV in @swarmy/app-config). SMTP_PASS and EMAIL_API_KEY are
 * Docker secrets: masked here; revealing one is on Email (`secrets.read`).
 */
export function AppMailEnv({ stack, overview: o, cred }: { stack: string; overview: EmailOverviewData; cred: EmailCredentialData }): React.JSX.Element {
  const sys = o.domains.find((d) => d.verifiedAt && d.id === o.systemDomainId) ?? o.domains.find((d) => d.verifiedAt);
  const rows: Array<[string, string, boolean?]> = [
    ['SMTP_HOST', o.mta.host],
    ['SMTP_PORT', String(o.mta.port)],
    ['SMTP_USER', cred.smtpUsername],
    ['SMTP_PASS', SECRET, true],
    ['SMTP_FROM · EMAIL_FROM', sys ? `email.from, else noreply@${sys.domain}` : 'email.from'],
    ['EMAIL_API_URL', o.apiUrl],
    ['EMAIL_API_KEY', cred.apiKeyPrefix ? `${cred.apiKeyPrefix}•••• secret` : SECRET, true],
  ];
  return (
    <Section
      title="Credentials"
      hint={`${cred.name}${cred.disabled ? ' · turned off' : ''}`}
      action={<Link to="/stacks/$name/config" params={{ name: stack }}><SectionLink>bound to {stack} →</SectionLink></Link>}
    >
      <dl className="flex flex-col">
        {rows.map(([k, v, secret]) => (
          <div key={k} className="border-border flex flex-wrap items-baseline gap-x-4 gap-y-0.5 border-b py-1.5 last:border-b-0">
            <dt className="w-44 shrink-0 font-mono text-[12px] font-semibold">{k}</dt>
            <dd className={secret ? 'text-muted-foreground font-mono text-[12px]' : 'min-w-0 truncate font-mono text-[12px]'}>{v}</dd>
          </div>
        ))}
      </dl>
      <Tech>
        HTTP API: POST {o.apiUrl}/send
        {cred.webhookUrl ? ` · bounces & complaints → ${cred.webhookUrl} (signed)` : ''}
        {cred.domains.length ? ` · may send from ${cred.domains.join(', ')}` : ' · may send from any verified domain'}
      </Tech>
    </Section>
  );
}
