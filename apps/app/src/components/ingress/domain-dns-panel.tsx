import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { RefreshCwIcon } from 'lucide-react';
import { Button, StatusBadge, toast } from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';
import { DOMAIN_STATE_LABEL, domainStateTone } from './domain-state';

/**
 * DNS + certificate panel for one domain: the state in plain words, the exact
 * records to create, what public DNS answers now, and the certificate each
 * edge serves. Functional only — styling follows the redesign later.
 */
export function DomainDnsPanel({ host }: { host: string }): React.JSX.Element {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const status = useQuery({ ...trpc.ingress.domainStatus.queryOptions({ host }), refetchInterval: 10_000 });
  const verify = useMutation(
    trpc.ingress.verifyDomain.mutationOptions({
      onSuccess: (d) => {
        toast.success(d.state === 'waiting_dns' ? 'Still waiting for DNS' : `DNS ${DOMAIN_STATE_LABEL[d.state]}`);
        void qc.invalidateQueries();
      },
      onError: (e) => toast.error(e.message),
    }),
  );
  const d = status.data;
  if (!d) return <div className="text-muted-foreground px-6 py-4 text-xs">{status.isError ? status.error.message : 'Checking DNS…'}</div>;

  return (
    <div className="space-y-3 border-t px-6 py-4">
      <div className="flex flex-wrap items-center gap-3">
        <StatusBadge tone={domainStateTone(d.state)} label={DOMAIN_STATE_LABEL[d.state]} />
        <p className="min-w-0 flex-1 text-sm">{d.reason}</p>
        <Button variant="outline" size="sm" disabled={verify.isPending} onClick={() => verify.mutate({ host })}>
          <RefreshCwIcon className="size-4" /> {verify.isPending ? 'Checking…' : 'Check again'}
        </Button>
      </div>
      {d.warnings.map((w) => (
        <p key={w} className="text-tone-warn text-xs">
          {w}
        </p>
      ))}

      {d.guidance.wildcard ? (
        <p className={d.guidance.wildcard.provider ? 'text-muted-foreground text-xs' : 'text-tone-warn text-xs'}>
          <span className="mono-label">Wildcard certificate · </span>
          {d.guidance.wildcard.summary}
        </p>
      ) : null}

      {d.state === 'waiting_dns' || d.state === 'error' ? (
        <div className="space-y-2">
          <p className="text-muted-foreground text-xs">{d.guidance.summary}</p>
          <RecordTable records={d.guidance.records} />
          {d.guidance.alternatives.length > 0 ? (
            <>
              <p className="text-muted-foreground text-xs">Or, instead:</p>
              <RecordTable records={d.guidance.alternatives} />
            </>
          ) : null}
          {d.gated ? (
            <p className="text-muted-foreground text-xs">
              swarmy won&rsquo;t request a certificate until DNS points here, so Let&rsquo;s Encrypt is never asked for a name
              that can&rsquo;t validate.
            </p>
          ) : null}
        </div>
      ) : null}

      <dl className="text-muted-foreground mono-label grid gap-1 text-xs sm:grid-cols-2">
        {d.dns ? (
          <div>
            <dt className="inline">Public DNS: </dt>
            <dd className="inline">{[...d.dns.a, ...d.dns.aaaa].join(', ') || 'no answer'}</dd>
          </div>
        ) : null}
        {d.certificate ? (
          <div>
            <dt className="inline">Certificate: </dt>
            <dd className="inline">
              {d.certificate.expiresAt
                ? `${d.certificate.issuer ?? 'issued'} · expires ${d.certificate.expiresAt.slice(0, 10)}`
                : d.certificate.error ?? 'none yet'}
            </dd>
          </div>
        ) : null}
        {d.lastCheckedAt ? (
          <div>
            <dt className="inline">Last checked: </dt>
            <dd className="inline">{new Date(d.lastCheckedAt).toLocaleTimeString()}</dd>
          </div>
        ) : null}
      </dl>

      {d.companion ? (
        <p className="text-xs">
          <span className="mono-data">{d.companion.host}</span>:{' '}
          <StatusBadge tone={domainStateTone(d.companion.state)} label={DOMAIN_STATE_LABEL[d.companion.state]} /> {d.companion.reason}
        </p>
      ) : null}
    </div>
  );
}

function RecordTable({
  records,
}: {
  records: Array<{ type: string; name: string; label: string; value: string; note?: string }>;
}): React.JSX.Element | null {
  if (records.length === 0) return null;
  return (
    <div className="overflow-x-auto">
      <table className="mono-data w-full text-xs">
        <thead className="text-muted-foreground text-left">
          <tr>
            <th className="pr-4 font-normal">Type</th>
            <th className="pr-4 font-normal">Name</th>
            <th className="pr-4 font-normal">Value</th>
            <th className="font-normal" />
          </tr>
        </thead>
        <tbody>
          {records.map((r) => (
            <tr key={`${r.type}${r.name}${r.value}`}>
              <td className="pr-4">{r.type}</td>
              <td className="pr-4" title={r.name}>
                {r.label}
              </td>
              <td className="pr-4">
                <button
                  type="button"
                  className="hover:underline"
                  title="Copy"
                  onClick={() => void navigator.clipboard?.writeText(r.value).then(() => toast.success('Copied'))}
                >
                  {r.value}
                </button>
              </td>
              <td className="text-muted-foreground">{r.note ?? ''}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
