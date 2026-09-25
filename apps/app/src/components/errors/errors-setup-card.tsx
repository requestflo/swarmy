import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { BugIcon, KeyRoundIcon } from 'lucide-react';
import { Button, Card, CopyButton, Input, StatusBadge, Switch, toast } from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';

interface ErrorsSetupCardProps {
  stack: string;
}

/**
 * The tab hero: this app's error-tracking switch (the `swarmy.errors.enabled`
 * label), its Sentry DSN, and what still has to happen (turn the store on,
 * redeploy to bind SENTRY_DSN). Existing Sentry SDKs need nothing else.
 */
export function ErrorsSetupCard({ stack }: ErrorsSetupCardProps): React.JSX.Element {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const status = useQuery({ ...trpc.errors.status.queryOptions({ stack }), refetchInterval: 10_000 });
  const s = status.data ?? null;
  const invalidate = () => void qc.invalidateQueries({ queryKey: trpc.errors.status.queryKey({ stack }) });

  const setEnabled = useMutation(
    trpc.errors.setEnabled.mutationOptions({
      onSuccess: (r) => {
        toast.success(r?.enabled ? 'Error tracking on — redeploy to bind SENTRY_DSN' : 'Error tracking off');
        invalidate();
      },
      onError: (e) => toast.error(e.message),
    }),
  );
  const rotate = useMutation(
    trpc.errors.rotateKey.mutationOptions({
      onSuccess: () => {
        toast.success('New DSN issued — redeploy (and rebuild browser bundles) to pick it up');
        invalidate();
      },
      onError: (e) => toast.error(e.message),
    }),
  );

  const enabled = !!s?.enabled;
  const dsn = s?.project?.dsn ?? '';
  const pending = s?.pendingRedeploy ?? [];

  return (
    <Card className="calm-card shadow-none mb-4 border-0 p-5">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0 space-y-1">
          <p className="flex items-center gap-2 text-base font-semibold">
            <BugIcon className="size-4" /> Error tracking
          </p>
          <p className="text-muted-foreground max-w-prose text-sm">
            Works with any Sentry SDK, unchanged. Turn it on and <span className="mono-data">{stack}</span> gets{' '}
            <span className="mono-data">SENTRY_DSN</span>, <span className="mono-data">SENTRY_RELEASE</span> (the git sha)
            and <span className="mono-data">SENTRY_ENVIRONMENT</span> on its next deploy.
          </p>
        </div>
        <label className="flex items-center gap-3 text-sm font-medium">
          {status.isLoading ? '…' : enabled ? 'On' : 'Off'}
          <Switch
            checked={enabled}
            disabled={status.isLoading || setEnabled.isPending}
            onCheckedChange={(v) => setEnabled.mutate({ stack, enabled: v })}
            aria-label="Error tracking for this app"
          />
        </label>
      </div>

      {s && !s.storeEnabled ? (
        <p className="text-tone-warn mt-4 text-sm">
          Events are stored in the observability store, which is off.{' '}
          <Link to="/stacks/$name/observability" params={{ name: stack }} className="underline underline-offset-2">
            Turn Observability on
          </Link>{' '}
          first — until then events are accepted and dropped.
        </p>
      ) : null}

      {dsn ? (
        <div className="mt-4 space-y-2">
          <p className="mono-label text-muted-foreground">DSN</p>
          <div className="bg-muted/60 flex items-center gap-2 rounded-xl px-3 py-2">
            <code className="mono-data min-w-0 flex-1 truncate text-xs">{dsn}</code>
            <CopyButton value={dsn} />
          </div>
          <div className="text-muted-foreground flex flex-wrap items-center gap-x-4 gap-y-2 text-xs">
            <span className="flex items-center gap-1.5">
              Project <span className="mono-data">{s?.project?.projectId}</span> · up to{' '}
              {s?.project ? <RateLimitInput stack={stack} perMinute={s.project.rateLimitPerMinute} /> : null} events/min
            </span>
            <span>Browser bundles: pass the DSN at build time; it is safe to ship.</span>
            <Button
              variant="ghost"
              size="sm"
              className="h-7 px-2"
              disabled={rotate.isPending}
              onClick={() => rotate.mutate({ stack })}
            >
              <KeyRoundIcon className="size-3.5" /> Rotate key
            </Button>
          </div>
        </div>
      ) : null}

      {enabled && pending.length ? (
        <p className="mt-3 flex flex-wrap items-center gap-2 text-sm">
          <StatusBadge tone="progress" label="redeploy needed" />
          <span className="text-muted-foreground">
            {pending.length === 1 ? pending[0] : `${pending.length} services`} still run without SENTRY_DSN.
          </span>
        </p>
      ) : null}
    </Card>
  );
}

/** The per-app ingest cap: events past it get a 429 with Retry-After. */
function RateLimitInput({ stack, perMinute }: { stack: string; perMinute: number }): React.JSX.Element {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const [draft, setDraft] = React.useState(String(perMinute));
  React.useEffect(() => setDraft(String(perMinute)), [perMinute]);
  const save = useMutation(
    trpc.errors.setRateLimit.mutationOptions({
      onSuccess: (p) => {
        toast.success(`Capped at ${p.rateLimitPerMinute} events/min`);
        void qc.invalidateQueries({ queryKey: trpc.errors.status.queryKey({ stack }) });
      },
      onError: (e) => toast.error(e.message),
    }),
  );
  const n = Number(draft);
  const valid = Number.isInteger(n) && n >= 1 && n <= 100_000;
  return (
    <form
      className="inline-flex items-center gap-1.5"
      onSubmit={(e) => {
        e.preventDefault();
        if (valid && n !== perMinute) save.mutate({ stack, perMinute: n });
      }}
    >
      <Input
        type="number"
        min={1}
        max={100_000}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        aria-label="Events per minute"
        className="mono-data h-7 w-20 px-2 text-xs"
      />
      {valid && n !== perMinute && (
        <Button type="submit" size="sm" variant="outline" className="h-7 px-2" disabled={save.isPending}>
          Save
        </Button>
      )}
    </form>
  );
}
