import * as React from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import type { StatusPageView } from '@swarmy/core';
import { Button, toast } from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';
import { Depth, Section, StatusWord, Tech } from '@/components/calm';
import { QuietSwitch } from '@/components/rowpage/row-page';
import { StatusPageInlineForm } from './status-page-inline-form';

/** "Domain": the address visitors use, how HTTPS is handled, live/off, and the page's own settings at Controls. */
export function StatusDomainSection({ page }: { page: StatusPageView }): React.JSX.Element {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const [editing, setEditing] = React.useState(false);
  const setEnabled = useMutation(
    trpc.statusPages.setEnabled.mutationOptions({
      onSuccess: (p) => {
        toast.success(p.enabled ? `${p.title} is live.` : `${p.title} is switched off — visitors get “not found”.`);
        void qc.invalidateQueries();
      },
      onError: (e) => toast.error(e.message),
    }),
  );
  return (
    <Section
      title="Domain"
      action={
        <label className="text-muted-foreground inline-flex items-center gap-2 text-xs font-semibold">
          {page.enabled ? 'Live' : 'Off'}
          <QuietSwitch checked={page.enabled} disabled={setEnabled.isPending} onCheckedChange={(enabled) => setEnabled.mutate({ id: page.id, enabled })} aria-label={page.enabled ? 'Switch the page off' : 'Put the page live'} />
        </label>
      }
    >
      {page.domain ? (
        <div className="flex flex-col gap-1">
          <a href={`https://${page.domain}`} target="_blank" rel="noreferrer" className="w-fit font-mono text-[13px] font-semibold hover:underline">
            {page.domain} ↗
          </a>
          <StatusWord tone="info" word="HTTPS is set up automatically once this address points here" className="font-normal" />
          <Tech>{`controller vhost ${page.domain} → /s/${page.slug} · tls auto`}</Tech>
        </div>
      ) : (
        <p className="text-sm">
          Visitors use{' '}
          <a href={page.publicPath} target="_blank" rel="noreferrer" className="font-mono font-semibold hover:underline">
            {page.publicPath}
          </a>{' '}
          on this dashboard’s address. Give it your own, like status.yourdomain.com.
        </p>
      )}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <Link to="/network" className="text-muted-foreground hover:text-foreground inline-flex min-h-11 items-center font-mono text-xs underline-offset-2 hover:underline">
          Domain settings →
        </Link>
        <Depth at="controls">
          <Button variant="outline" size="sm" onClick={() => setEditing((v) => !v)} className="pointer-coarse:min-h-11">
            {editing ? 'Close' : 'Edit address and page'}
          </Button>
        </Depth>
      </div>
      {editing ? (
        <div className="border-border border-t pt-4">
          <StatusPageInlineForm page={page} onDone={() => setEditing(false)} onCancel={() => setEditing(false)} />
        </div>
      ) : null}
    </Section>
  );
}
