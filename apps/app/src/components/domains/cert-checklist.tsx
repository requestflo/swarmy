import * as React from 'react';
import { CheckIcon } from 'lucide-react';
import { cn } from '@swarmy/ui';
import { Section, StatusWord, Tech } from '@/components/calm';
import type { DomainDetail } from '@/components/ingress/domain-state';

type Mark = 'done' | 'now' | 'bad' | 'todo';

/**
 * The certificate, in the steps swarmy can actually see: DNS verified (the
 * gate opens), a trusted certificate served (the TLS probe), and which edges
 * serve it (the probe runs per edge). ACME order internals (order created,
 * challenge served, finalized) aren't observable from the controller, so
 * they're one "issuing" step here.
 */
export function CertChecklist({ d, tls, edgeName, edgeCount }: { d: DomainDetail; tls: string | null; edgeName: (ip: string) => string; edgeCount: number }): React.JSX.Element {
  if (tls === 'off') {
    return (
      <Section title="Certificate">
        <p className="text-muted-foreground text-[13.5px]">HTTPS is off for this domain, so there is no certificate to get.</p>
      </Section>
    );
  }
  const c = d.certificate;
  const verified = d.verifiedAt !== null;
  const issued = !!c?.expiresAt;
  const edges = c?.edges ?? [];
  const okEdges = edges.filter((e) => e.ok).length;
  const failing = d.state === 'error' && verified;
  const steps: Array<{ mark: Mark; label: string; detail: string }> = [
    {
      mark: verified ? 'done' : 'now',
      label: 'DNS points here',
      detail: d.verifiedManually ? 'the DNS check was skipped by an admin' : verified ? 'the front door may now ask Let’s Encrypt' : 'swarmy won’t ask until it does',
    },
    {
      mark: issued ? 'done' : failing ? 'bad' : verified ? 'now' : 'todo',
      label: tls === 'custom' ? 'Your certificate is served' : 'Let’s Encrypt issues it',
      detail: issued ? `${c?.issuer ?? 'trusted issuer'} · until ${c?.expiresAt?.slice(0, 10)}` : c?.error ?? (verified ? 'usually within a minute or two' : 'waits for DNS'),
    },
    {
      mark: issued && okEdges === edges.length && edges.length > 0 ? 'done' : issued ? 'now' : 'todo',
      label: Math.max(edges.length, edgeCount) > 1 ? 'On every edge' : 'On your edge',
      detail: edges.length ? `${okEdges} of ${edges.length} serving it` : 'checked with a TLS handshake to each edge',
    },
  ];
  const sub = !verified ? 'waits for DNS' : issued && okEdges === edges.length ? 'done' : failing ? 'needs you' : 'in progress';
  return (
    <Section title="Certificate" hint={sub}>
      <ol className="flex flex-col gap-2.5">
        {steps.map((s) => (
          <li key={s.label} className="flex gap-3">
            <Dot mark={s.mark} />
            <span className="flex min-w-0 flex-col">
              <span className={cn('text-[13.5px] font-semibold', s.mark === 'todo' && 'text-muted-foreground')}>{s.label}</span>
              <span className="text-muted-foreground font-mono text-[11.5px] break-words">{s.detail}</span>
            </span>
          </li>
        ))}
      </ol>
      {edges.length ? (
        <div className="flex flex-wrap gap-x-4 gap-y-1">
          {edges.map((e) => (
            <StatusWord key={e.ip} tone={e.ok ? 'ok' : 'warn'} word={`${edgeName(e.ip)} ${e.ok ? 'ok' : 'not yet'}`} />
          ))}
        </div>
      ) : null}
      {c ? <Tech>issuer {c.issuer ?? '—'} · expires {c.expiresAt ?? '—'} · probed {c.checkedAt ?? '—'}{edges.filter((e) => e.error).map((e) => ` · ${e.ip}: ${e.error}`).join('')}</Tech> : null}
    </Section>
  );
}

function Dot({ mark }: { mark: Mark }): React.JSX.Element {
  return (
    <span
      aria-hidden
      className={cn(
        'mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full border-[1.5px]',
        mark === 'done' && 'border-status-online text-tone-ok',
        mark === 'now' && 'border-status-progress',
        mark === 'bad' && 'border-status-offline',
        mark === 'todo' && 'border-border',
      )}
    >
      {mark === 'done' ? <CheckIcon className="size-3" /> : null}
    </span>
  );
}
