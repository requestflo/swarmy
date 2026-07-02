import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Label, Switch, toast } from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';

/** Gateway toggles: request audit log + exact-match response cache. */
export function SettingsCard(): React.JSX.Element {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const settings = useQuery({ ...trpc.ai.settings.queryOptions(), refetchInterval: 15_000 });
  const save = useMutation(
    trpc.ai.setSettings.mutationOptions({
      onSuccess: () => void qc.invalidateQueries(),
      onError: (e) => toast.error(e.message),
    }),
  );

  const s = settings.data;

  return (
    <div className="card-pop p-5">
      <p className="font-semibold">Gateway settings</p>
      <p className="text-muted-foreground text-xs">Applies to every request through the gateway.</p>

      {settings.isLoading || !s ? (
        <div className="mt-4 space-y-3">
          <div className="shimmer-line h-10 rounded-lg" />
          <div className="shimmer-line h-10 rounded-lg" />
        </div>
      ) : (
        <div className="mt-4 space-y-4">
          <div className="flex items-start justify-between gap-3">
            <div>
              <Label className="text-sm font-medium">Request audit log</Label>
              <p className="text-muted-foreground text-xs">
                Store one row per request with a redacted (200-char) prompt.
              </p>
            </div>
            <Switch
              checked={s.auditLog}
              disabled={save.isPending}
              onCheckedChange={(v) => save.mutate({ auditLog: v })}
            />
          </div>
          <div className="flex items-start justify-between gap-3">
            <div>
              <Label className="text-sm font-medium">Response cache</Label>
              <p className="text-muted-foreground text-xs">
                Serve identical non-streaming requests from a 5-minute cache — repeated calls cost
                nothing.
              </p>
            </div>
            <Switch
              checked={s.cache}
              disabled={save.isPending}
              onCheckedChange={(v) => save.mutate({ cache: v })}
            />
          </div>
        </div>
      )}
    </div>
  );
}
