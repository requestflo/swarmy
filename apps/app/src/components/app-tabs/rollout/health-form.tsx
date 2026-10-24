import * as React from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { DOCKER_HEALTH_DEFAULTS as D, type InvService, type SpecHealthcheck } from '@swarmy/core';
import type { ServiceSpec } from '@swarmy/core/protocol';
import { Button, Input, toast } from '@swarmy/ui';
import { Tech } from '@/components/calm';
import { Segmented, type SegOption } from '@/components/service-settings/settings-row';
import { orderOf, parallelismOf } from '@/components/service-settings/settings-model';
import { useTRPC } from '@/integrations/trpc';
import { countWord } from '../tab-body';
import { editOf, formOf, previewOf, type AskKind, type HealthForm as Form } from './health-draft';
import { HealthField } from './health-field';

const ASKS: SegOption<AskKind>[] = [
  { value: 'http', label: 'A web page' },
  { value: 'command', label: 'A command' },
  { value: 'off', label: 'Off' },
];
const field = 'h-8 font-mono text-[13px] pointer-coarse:min-h-11';

/**
 * The health check at Controls (board AppRollout): the same five facts as
 * Summary, now editable, with Docker's defaults shown. Save is ONE
 * services.update, so Docker replaces the copies in one rolling update.
 */
export function HealthForm({
  name,
  inv,
  spec,
  imageTest,
  onDraft,
}: {
  name: string;
  inv: InvService;
  spec: ServiceSpec;
  /** The image's own check, when the service sets none. */
  imageTest: string[] | null;
  /** The check Save would write (null = no unsaved change), for the Code view. */
  onDraft: (hc: SpecHealthcheck | undefined | null) => void;
}): React.JSX.Element {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const live = spec.healthcheck;
  const own = !!(live?.disable || live?.test?.length);
  const baseKey = JSON.stringify([own ? live : imageTest, inv.ports[0]?.target]);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on the check's content, not its identity (the spec refetches).
  const base = React.useMemo(() => formOf(own ? live : imageTest ? { test: imageTest } : undefined, inv.ports[0]?.target), [baseKey]);
  const [f, setF] = React.useState<Form>(base);
  React.useEffect(() => setF(base), [base]);
  const set = (p: Partial<Form>): void => setF((x) => ({ ...x, ...p }));
  const dirty = JSON.stringify(f) !== JSON.stringify(base) || (!own && !imageTest);
  const { edit, error } = dirty ? editOf(base, f, !own) : { edit: null, error: null };
  const editKey = JSON.stringify(edit);
  React.useEffect(() => onDraft(edit ? previewOf(live, edit) : null), [editKey]); // eslint-disable-line react-hooks/exhaustive-deps
  React.useEffect(() => () => onDraft(null), []); // eslint-disable-line react-hooks/exhaustive-deps
  const save = useMutation(
    trpc.services.update.mutationOptions({
      onSuccess: () => {
        toast.success(`Saved. ${name}’s copies are being replaced one at a time, each with the new check.`);
        void qc.invalidateQueries();
      },
      onError: (e) => toast.error(e.message),
    }),
  );
  const busy = save.isPending;
  return (
    <div className="flex flex-col gap-3.5">
      <div className="flex flex-col gap-1.5">
        <span className="text-muted-foreground text-[12px]">Ask for</span>
        <Segmented label={`What ${name}’s health check asks for`} options={ASKS} value={f.ask} onChange={(ask) => set({ ask })} disabled={busy} />
        {f.ask === 'http' ? (
          <div className="flex flex-wrap items-center gap-2 text-[13px]">
            <span className="font-mono text-[12.5px]">GET</span>
            <Input aria-label="Path to ask for" value={f.path} onChange={(e) => set({ path: e.target.value })} placeholder="/health" className={`${field} w-44`} disabled={busy} />
            <span className="text-muted-foreground">on port</span>
            <Input aria-label="Port inside the container" inputMode="numeric" value={f.port} onChange={(e) => set({ port: e.target.value })} placeholder="3000" className={`${field} w-24`} disabled={busy} />
            <span className="text-muted-foreground text-[12px]">inside the container, with curl or wget</span>
          </div>
        ) : f.ask === 'command' ? (
          <Input aria-label="Command that exits 0 when healthy" value={f.command} onChange={(e) => set({ command: e.target.value })} placeholder="pg_isready -U app" className={field} disabled={busy} />
        ) : (
          <p className="text-muted-foreground text-[13px]">No check: a copy counts as up as soon as it starts, even one built into the image.</p>
        )}
      </div>
      {f.ask !== 'off' ? (
        <div className="grid grid-cols-2 gap-x-5 gap-y-3 sm:grid-cols-4">
          <HealthField label="Every" value={f.interval} onChange={(interval) => set({ interval })} unit="s" dflt={String(D.intervalSec)} hint="between checks" disabled={busy} />
          <HealthField label="Give up after" value={f.timeout} onChange={(timeout) => set({ timeout })} unit="s" dflt={String(D.timeoutSec)} hint="a slower answer is a miss" disabled={busy} />
          <HealthField label="Unhealthy after" value={f.retries} onChange={(retries) => set({ retries })} unit="misses" dflt={String(D.retries)} hint="in a row" disabled={busy} />
          <HealthField label="Grace on start" value={f.start} onChange={(start) => set({ start })} unit="s" dflt={String(D.startSec)} hint="misses don’t count yet" disabled={busy} />
        </div>
      ) : null}
      {error ? <p className="text-tone-warn text-[13px]">{error}</p> : null}
      <div className="flex flex-wrap items-center gap-3">
        <Button variant={edit ? 'default' : 'outline'} disabled={!edit || busy} onClick={() => edit && save.mutate({ id: inv.id, healthcheck: edit })} className="pointer-coarse:min-h-11">
          {busy ? 'Saving…' : 'Save and roll out'}
        </Button>
        {dirty && own ? (
          <Button variant="ghost" disabled={busy} onClick={() => setF(base)} className="pointer-coarse:min-h-11">
            Undo changes
          </Button>
        ) : null}
        <span className="text-muted-foreground text-[12.5px]">
          {edit ? `${name}’s copies are replaced ${countWord(parallelismOf(spec), true)} at a time; nothing else about it changes.` : 'Change a field to save it.'}
        </span>
      </div>
      <Tech>
        services.update healthcheck · one rolling update ({orderOf(spec)}, parallelism {parallelismOf(spec)}){edit ? ` · ${JSON.stringify(edit)}` : ''}
      </Tech>
    </div>
  );
}
