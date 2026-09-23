import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Button,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Switch,
  cn,
  toast,
} from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';
import { Field } from './field';

export interface OffsiteDestination {
  id: string;
  name: string;
  eligible: boolean;
  reason: string | null;
}

export interface OffsiteMirrorConfig {
  targetId: string;
  allBuckets: boolean;
  buckets: string[];
  prefix: string;
  everyMinutes: number;
  mode: 'copy' | 'sync';
  graceDays: number;
  enabled: boolean;
}

/** Schedule choices (minutes) — hourly is the default. */
export const MIRROR_SCHEDULES: Array<{ value: number; label: string }> = [
  { value: 15, label: 'Every 15 minutes' },
  { value: 60, label: 'Hourly' },
  { value: 360, label: 'Every 6 hours' },
  { value: 1440, label: 'Daily' },
];

interface OffsiteMirrorFormProps {
  destinations: OffsiteDestination[];
  initial: OffsiteMirrorConfig | null;
  onDone: () => void;
}

/** Inline mirror config — expands inside the card, never a modal. */
export function OffsiteMirrorForm({
  destinations,
  initial,
  onDone,
}: OffsiteMirrorFormProps): React.JSX.Element {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const eligible = destinations.filter((d) => d.eligible);
  const [targetId, setTargetId] = React.useState(initial?.targetId ?? eligible[0]?.id ?? '');
  const [allBuckets, setAllBuckets] = React.useState(initial?.allBuckets ?? true);
  const [buckets, setBuckets] = React.useState<string[]>(initial?.buckets ?? []);
  const [everyMinutes, setEveryMinutes] = React.useState(String(initial?.everyMinutes ?? 60));
  const [mode, setMode] = React.useState<'copy' | 'sync'>(initial?.mode ?? 'copy');
  const [prefix, setPrefix] = React.useState(initial?.prefix ?? 'swarmy-mirror');

  // The picker lists the live store's buckets (Garage is the source of truth).
  const store = useQuery({ ...trpc.buckets.overview.queryOptions(), enabled: !allBuckets });
  const storeBuckets = store.data?.buckets.map((b) => b.name) ?? [];
  const pickable = [...new Set([...storeBuckets, ...buckets])].sort();

  const save = useMutation(
    trpc.offsiteMirror.save.mutationOptions({
      onSuccess: () => {
        toast.success(initial ? 'Mirror updated' : 'Mirror on — the first copy starts within a minute');
        onDone();
        void qc.invalidateQueries();
      },
      onError: (e) => toast.error(e.message),
    }),
  );

  const toggle = (name: string) =>
    setBuckets((cur) => (cur.includes(name) ? cur.filter((b) => b !== name) : [...cur, name]));

  const ineligible = destinations.filter((d) => !d.eligible);

  return (
    <div className="bg-accent/40 grid gap-4 border-t px-6 py-5 sm:grid-cols-2">
      <Field label="Off-site destination">
        <Select value={targetId} onValueChange={setTargetId}>
          <SelectTrigger>
            <SelectValue placeholder={eligible.length ? 'Pick a destination' : 'Add an S3 destination first'} />
          </SelectTrigger>
          <SelectContent>
            {eligible.map((d) => (
              <SelectItem key={d.id} value={d.id}>
                {d.name}
              </SelectItem>
            ))}
            {ineligible.map((d) => (
              <SelectItem key={d.id} value={d.id} disabled>
                {d.name} — {d.reason}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>

      <Field label="Schedule">
        <Select value={everyMinutes} onValueChange={setEveryMinutes}>
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {MIRROR_SCHEDULES.map((s) => (
              <SelectItem key={s.value} value={String(s.value)}>
                {s.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>

      <Field label="Mode">
        <Select value={mode} onValueChange={(v) => setMode(v as 'copy' | 'sync')}>
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="copy">Copy — never delete off-site (safest)</SelectItem>
            <SelectItem value="sync">Sync — deletes follow after {initial?.graceDays ?? 7} days</SelectItem>
          </SelectContent>
        </Select>
      </Field>

      <Field label="Path in the destination bucket">
        <Input value={prefix} onChange={(e) => setPrefix(e.target.value)} placeholder="swarmy-mirror" />
      </Field>

      <div className="grid gap-3 sm:col-span-2">
        <label className="flex items-center gap-3 text-sm font-medium">
          <Switch checked={allBuckets} onCheckedChange={setAllBuckets} />
          Every bucket — backups, edge certificates and app buckets
        </label>
        {!allBuckets ? (
          <div className="flex flex-wrap gap-2">
            {store.isLoading ? (
              <span className="shimmer-line h-8 w-48 rounded-full" />
            ) : pickable.length === 0 ? (
              <p className="text-muted-foreground text-sm">No buckets in the object store yet.</p>
            ) : (
              pickable.map((name) => {
                const on = buckets.includes(name);
                return (
                  <button
                    key={name}
                    type="button"
                    onClick={() => toggle(name)}
                    className={cn(
                      'mono-data rounded-full border px-3 py-1.5 text-xs transition-colors',
                      on
                        ? 'bg-ink text-ink-foreground border-transparent'
                        : 'hover:bg-accent text-muted-foreground',
                    )}
                    aria-pressed={on}
                  >
                    {name}
                  </button>
                );
              })
            )}
          </div>
        ) : null}
      </div>

      <div className="flex flex-wrap items-center justify-end gap-2 sm:col-span-2">
        <Button size="sm" variant="ghost" className="rounded-full" onClick={onDone}>
          Cancel
        </Button>
        <Button
          size="sm"
          className="rounded-full font-bold"
          disabled={save.isPending || !targetId || (!allBuckets && buckets.length === 0)}
          onClick={() =>
            save.mutate({
              targetId,
              allBuckets,
              buckets: allBuckets ? [] : buckets,
              prefix: prefix.trim() || undefined,
              everyMinutes: Number(everyMinutes),
              mode,
              enabled: initial?.enabled ?? true,
            })
          }
        >
          {save.isPending ? 'Saving…' : initial ? 'Save mirror' : 'Start mirroring'}
        </Button>
      </div>
    </div>
  );
}
