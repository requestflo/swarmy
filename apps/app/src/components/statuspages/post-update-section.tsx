import * as React from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { INCIDENT_UPDATE_PHASES, type IncidentUpdatePhase, type IncidentView, type StatusPageView } from '@swarmy/core';
import { Button, Label, Textarea, cn, toast } from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';
import { Section, Tech } from '@/components/calm';
import { QuietSwitch } from '@/components/rowpage/row-page';
import { PHASE_LABEL } from './status-copy';
import { usePageUpdate } from './use-page-update';

/** "Post an update": pick the phase, say what's going on, post it to the incident's public updates. */
export function PostUpdateSection({ page, open, incidentId, onPick }: { page: StatusPageView; open: IncidentView[]; incidentId?: string; onPick: (id: string) => void }): React.JSX.Element {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const incident = open.find((i) => i.id === incidentId) ?? open[0];
  const [phase, setPhase] = React.useState<IncidentUpdatePhase>('investigating');
  const [message, setMessage] = React.useState('');
  const toggle = usePageUpdate();
  const post = useMutation(
    trpc.incidents.postUpdate.mutationOptions({
      onSuccess: (d) => {
        setMessage('');
        toast.success(d.status === 'resolved' ? 'Posted, and the incident is resolved.' : 'Posted — visitors see it within 30 seconds.');
        void qc.invalidateQueries();
      },
      onError: (e) => toast.error(e.message),
    }),
  );
  if (!incident) {
    return (
      <Section title="Post an update">
        <p className="text-muted-foreground text-sm">Nothing is open, so there’s nothing to tell visitors. When an incident opens, post updates here and they appear on the page.</p>
      </Section>
    );
  }
  return (
    <Section title="Post an update" hint={`to ${incident.title}`}>
      {open.length > 1 ? (
        <label className="flex flex-col gap-1 text-xs font-semibold">
          Incident
          <select value={incident.id} onChange={(e) => onPick(e.target.value)} className="border-input bg-background h-9 rounded-md border px-2 text-sm pointer-coarse:min-h-11">
            {open.map((i) => (
              <option key={i.id} value={i.id}>{i.title}</option>
            ))}
          </select>
        </label>
      ) : null}
      <div role="group" aria-label="Phase" className="border-border bg-background grid grid-cols-2 gap-0.5 rounded-[10px] border p-0.5 sm:grid-cols-4">
        {INCIDENT_UPDATE_PHASES.map((p) => (
          <button
            key={p}
            type="button"
            aria-pressed={phase === p}
            onClick={() => setPhase(p)}
            className={cn(
              'h-9 rounded-[8px] px-2 font-mono text-[12px] font-semibold outline-none focus-visible:ring-2 focus-visible:ring-ring/60 pointer-coarse:min-h-11',
              phase === p ? 'bg-surface-2 text-foreground dark:bg-accent' : 'text-muted-foreground hover:text-foreground',
            )}
          >
            {PHASE_LABEL[p]}
          </button>
        ))}
      </div>
      <Textarea
        aria-label="What visitors read"
        value={message}
        onChange={(e) => setMessage(e.target.value)}
        rows={3}
        placeholder={phase === 'resolved' ? 'Everything is back to normal. Sorry for the trouble.' : 'Some checkouts are failing. We are on it.'}
      />
      {phase === 'resolved' ? <p className="text-muted-foreground text-xs">Posting “Resolved” also resolves the incident.</p> : null}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <Button disabled={!message.trim() || post.isPending} onClick={() => post.mutate({ incidentId: incident.id, phase, message: message.trim() })} className="pointer-coarse:min-h-11">
          {post.isPending ? 'Posting…' : 'Post update'}
        </Button>
        <Label className="text-muted-foreground inline-flex items-center gap-2 text-sm font-normal">
          <QuietSwitch checked={page.showIncidents} disabled={toggle.isPending} onCheckedChange={(showIncidents) => toggle.mutate({ id: page.id, showIncidents })} />
          Show the current incident
        </Label>
      </div>
      <Tech>{`incidents.postUpdate · ${incident.id} · event status.${phase} {public: true}`}</Tech>
      <Link to="/activity" search={{ incident: incident.id }} className="text-muted-foreground hover:text-foreground w-fit font-mono text-xs">
        Open the incident →
      </Link>
    </Section>
  );
}
