import * as React from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Button, Card, CardContent, Label, Switch, toast } from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';

/**
 * The org-level row: serve DNS at all, and "Apply now". Location data and the
 * DB-IP attribution live in the Geo-DNS tab's Steering section.
 */
export function GeoDnsControlsCard({ config }: { config?: { enabled: boolean } }): React.JSX.Element {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const invalidate = (): void => void qc.invalidateQueries();
  const onErr = (e: { message: string }): void => void toast.error(e.message);

  const setEnabled = useMutation(
    trpc.geodns.setEnabled.mutationOptions({ onSuccess: invalidate, onError: onErr }),
  );
  const applyNow = useMutation(
    trpc.geodns.applyNow.mutationOptions({
      onSuccess: (r) => {
        // "…, 2 failed (host: why)" — a partial push is a failure, not a success.
        if (r.ok === false) toast.error(r.summary);
        else toast.success(r.summary);
        invalidate();
      },
      onError: onErr,
    }),
  );

  return (
    <Card className="calm-card">
      <CardContent className="flex flex-wrap items-center gap-x-6 gap-y-4 py-5">
        <div className="flex items-center gap-3">
          <Switch
            id="geodns-on"
            checked={!!config?.enabled}
            onCheckedChange={(v) => setEnabled.mutate({ enabled: v })}
            disabled={setEnabled.isPending || !config}
          />
          <div>
            <Label htmlFor="geodns-on" className="font-medium">
              Serve DNS
            </Label>
            <p className="text-muted-foreground text-xs">
              Deploys swarmy-dns on every ingress+outlet node.
            </p>
          </div>
        </div>

        <Button
          variant="outline"
          size="sm"
          className="ml-auto"
          onClick={() => applyNow.mutate()}
          disabled={applyNow.isPending || !config?.enabled}
          title="Compose, push to every DNS node and sync providers now"
        >
          Apply now
        </Button>
      </CardContent>
    </Card>
  );
}
