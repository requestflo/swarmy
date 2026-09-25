import * as React from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Button,
  Input,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  cn,
  toast,
} from '@swarmy/ui';
import { QuietSwitch } from '@/components/rowpage/row-page';
import { useTRPC } from '@/integrations/trpc';
import { usePlatformStatus } from './use-platform';

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const pad = (h: number) => `${String(h % 24).padStart(2, '0')}:00`;

/**
 * Release channel (Stable / optional Edge), opt-in patch auto-apply and its
 * maintenance window, and the feed URL (air-gapped estates point it at their
 * own mirror). Design board: Platform.html.
 */
export function PolicyCard({ admin }: { admin: boolean }): React.JSX.Element | null {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const q = usePlatformStatus();
  const set = useMutation(
    trpc.platform.setPolicy.mutationOptions({
      onSuccess: () => void qc.invalidateQueries(),
      onError: (e) => toast.error(e.message),
    }),
  );
  const policy = q.data?.release.policy;
  const [feed, setFeed] = React.useState<string | null>(null);
  if (!policy) return null;
  const w = policy.window;
  const toggleDay = (d: number) => {
    const days = w.days.includes(d) ? w.days.filter((x) => x !== d) : [...w.days, d].sort();
    if (days.length) set.mutate({ window: { ...w, days } });
  };

  return (
    <section className="calm-card grid gap-5 p-6" aria-label="Release policy">
      <div className="grid gap-2">
        <h3 className="text-base font-semibold">Release channel</h3>
        <div className="grid gap-2 sm:grid-cols-2" role="radiogroup" aria-label="Release channel">
          {(
            [
              ['stable', 'Stable', 'Tagged releases — the default'],
              ['edge', 'Edge', 'Every main build — new first'],
            ] as const
          ).map(([id, label, sub]) => (
            <button
              key={id}
              type="button"
              role="radio"
              aria-checked={policy.channel === id}
              disabled={!admin || set.isPending}
              onClick={() => set.mutate({ channel: id })}
              className={cn(
                'grid gap-0.5 rounded-xl border p-3 text-left transition-colors disabled:cursor-not-allowed',
                policy.channel === id ? 'border-primary/60 bg-primary/10' : 'hover:bg-muted/50',
              )}
            >
              <span className="text-sm font-semibold">{label}</span>
              <span className="text-muted-foreground text-xs">{sub}</span>
            </button>
          ))}
        </div>
      </div>

      <div className="grid gap-3">
        <div className="flex items-start gap-3">
          <div className="grid flex-1 gap-0.5">
            <Label htmlFor="auto-patch" className="text-sm font-semibold">
              Apply patch releases automatically
            </Label>
            <span className="text-muted-foreground text-xs">Only x.y.Z fixes on Stable, only inside the window. Majors and minors always wait for you.</span>
          </div>
          <QuietSwitch
            id="auto-patch"
            checked={policy.autoApplyPatches}
            disabled={!admin || set.isPending}
            onCheckedChange={(v) => set.mutate({ autoApplyPatches: v })}
          />
        </div>
        <div className="grid gap-2">
          <span className="text-muted-foreground text-xs font-semibold">Maintenance window · {policy.windowText}</span>
          <div className="flex flex-wrap items-center gap-1.5">
            {DAYS.map((d, i) => (
              <button
                key={d}
                type="button"
                aria-pressed={w.days.includes(i)}
                disabled={!admin || set.isPending}
                onClick={() => toggleDay(i)}
                className={cn(
                  'h-7 min-w-10 rounded-lg border px-2 text-xs font-semibold',
                  w.days.includes(i) ? 'border-primary/60 bg-primary/10 text-foreground' : 'text-muted-foreground',
                )}
              >
                {d}
              </button>
            ))}
            <Select value={String(w.startHour)} disabled={!admin} onValueChange={(v) => set.mutate({ window: { ...w, startHour: Number(v) } })}>
              <SelectTrigger className="h-8 w-24" aria-label="Window start (UTC)">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {Array.from({ length: 24 }, (_, h) => (
                  <SelectItem key={h} value={String(h)}>
                    {pad(h)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select value={String(w.hours)} disabled={!admin} onValueChange={(v) => set.mutate({ window: { ...w, hours: Number(v) } })}>
              <SelectTrigger className="h-8 w-24" aria-label="Window length">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {[1, 2, 3, 4, 6, 8].map((h) => (
                  <SelectItem key={h} value={String(h)}>
                    {h} h
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <span className="text-muted-foreground text-xs">UTC</span>
          </div>
        </div>
      </div>

      <div className="grid gap-1.5">
        <Label htmlFor="feed-url" className="text-muted-foreground text-xs font-semibold">
          Release feed
        </Label>
        <div className="flex gap-2">
          <Input
            id="feed-url"
            className="mono-data h-8 text-xs"
            placeholder="https://github.com/requestflo/swarmy/releases/download"
            value={feed ?? policy.feedUrl ?? ''}
            disabled={!admin}
            onChange={(e) => setFeed(e.target.value)}
          />
          {admin && feed !== null && feed !== (policy.feedUrl ?? '') ? (
            <Button size="sm" variant="outline" onClick={() => set.mutate({ feedUrl: feed || null }, { onSuccess: () => setFeed(null) })}>
              Save
            </Button>
          ) : null}
        </div>
        <span className="text-muted-foreground mono-data text-[11px] break-all">reads {policy.feed}</span>
      </div>
    </section>
  );
}
