import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, toast } from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';
import { RollbackConfirm } from '@/components/releases/rollback-confirm';
import { agoWords, lastGood, releaseLabel } from '@/components/app-tabs/releases/release-label';
import type { Intent } from '@/lib/intents';
import { DeployPane } from './deploy-intent-pane';
import { Pane, type PaneProps } from './intent-pane';

function RollbackPane({ intent, ctaRef, onDone, app }: PaneProps & { app: string }): React.JSX.Element {
  const trpc = useTRPC();
  const q = useQuery(trpc.releases.list.queryOptions({ stackName: app, limit: 30 }));
  const rows = q.data ?? [];
  const head = rows[0];
  const good = lastGood(rows);
  const foot = 'releases.rollback · redeploys that version as a new release (no REST route yet)';
  if (q.isPending) return <Pane eyebrow="Action · preview" title={intent.title} body="Looking up its versions…" rows={[]} cta={null} foot={foot} />;
  if (!head || !good) {
    return <Pane eyebrow="Action · preview" title={`Nothing to put back on ${app}.`} body="It has no earlier version that stayed healthy." rows={[]} cta={null} foot={foot} />;
  }
  return (
    <Pane
      eyebrow="Action · preview"
      title={`Put ${app} back to ${releaseLabel(good)}`}
      body={`It runs again one copy at a time, so visitors never see a gap. ${releaseLabel(head)} stays in the history and can come back the same way.`}
      rows={[
        ['Live now', `${releaseLabel(head)} · ${head.status}`],
        ['Goes back to', `${releaseLabel(good)} · ${agoWords(good.createdAt)}`],
        ['Your data', 'not touched'],
      ]}
      cta={<RollbackConfirm release={good} label={releaseLabel(good)} onDone={onDone} trigger={<Button ref={ctaRef}>Put back {releaseLabel(good)}</Button>} />}
      foot={foot}
    />
  );
}

function PartPane({ intent, ctaRef, onDone }: PaneProps): React.JSX.Element {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const a = intent.action;
  const done = {
    onSuccess: () => {
      toast.success(a.kind === 'scale' ? `${a.part.name} is moving to ${a.to} copies.` : `${intent.title.replace(/^Restart /, '')} is restarting, one copy at a time.`);
      void qc.invalidateQueries({ queryKey: trpc.services.list.queryKey() });
      onDone();
    },
    onError: (e: { message: string }) => toast.error(e.message),
  };
  const restart = useMutation(trpc.services.restart.mutationOptions(done));
  const scale = useMutation(trpc.services.scale.mutationOptions(done));
  if (a.kind !== 'restart' && a.kind !== 'scale') return <></>;
  const busy = restart.isPending || scale.isPending;
  const where: Array<[string, string]> = [['Part', a.part.name], ['App', a.part.app ?? '—']];
  return a.kind === 'restart' ? (
    <Pane
      eyebrow="Action · preview"
      title={intent.title}
      body="Each copy stops and starts again in turn, with the next one waiting until it is healthy. Nothing about its settings changes."
      rows={[...where, ['Copies', String(a.part.desired)]]}
      cta={<Button ref={ctaRef} disabled={busy} onClick={() => restart.mutate({ id: a.part.id })}>{busy ? 'Restarting…' : `Restart ${a.part.name}`}</Button>}
      foot={`POST /api/v1/services/${a.part.id}/restart`}
    />
  ) : (
    <Pane
      eyebrow="Action · preview"
      title={intent.title}
      body={a.to === 0 ? 'Every copy stops. It stays set up and starts again when you add a copy.' : 'swarmy places the copies on servers with room and keeps them apart where it can.'}
      rows={[...where, ['Copies', `${a.part.desired} → ${a.to}`]]}
      cta={<Button ref={ctaRef} disabled={busy} onClick={() => scale.mutate({ id: a.part.id, replicas: a.to })}>{busy ? 'Changing…' : `Run ${a.to} ${a.to === 1 ? 'copy' : 'copies'}`}</Button>}
      foot={`POST /api/v1/services/${a.part.id}/scale {"replicas":${a.to}}`}
    />
  );
}

/** The Command board's preview: what the highlighted intent will do, and its one button. */
export function IntentPreview(props: PaneProps): React.JSX.Element {
  const { intent, ctaRef, onGo } = props;
  const a = intent.action;
  if (a.kind === 'rollback') return <RollbackPane {...props} app={a.app} />;
  if (a.kind === 'deploy') return <DeployPane {...props} action={a} />;
  if (a.kind === 'restart' || a.kind === 'scale') return <PartPane {...props} />;
  const domain = a.to === '/stacks/$name/network' ? a.search?.add : undefined;
  return (
    <Pane
      eyebrow={intent.group === 'Do it' ? 'Action · opens the form' : 'Jump'}
      title={intent.title}
      body={domain !== undefined ? `Opens ${a.params?.name}'s Domains tab with the form ready${domain ? ` for ${domain}` : ''}. You pick which part answers, and swarmy gets the HTTPS certificate.` : `${intent.sub[0]?.toUpperCase()}${intent.sub.slice(1)}.`}
      rows={[]}
      cta={<Button ref={ctaRef} variant={intent.group === 'Do it' ? 'default' : 'outline'} onClick={() => onGo(intent)}>{intent.group === 'Do it' ? intent.title : 'Open'}</Button>}
      foot={domain !== undefined ? 'POST /api/v1/ingress/domains' : `open ${a.to.replace('$name', a.params?.name ?? '')}`}
    />
  );
}
