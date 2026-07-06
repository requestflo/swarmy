import * as React from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Button, Card, CardContent, Label, Switch, toast } from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';
import { GeoipSourcePicker, type GeoipSource } from './geoip-source-picker';

interface GeoDnsConfig {
  enabled: boolean;
  geoipSource: GeoipSource;
  maxmindLicenseSecretRef?: string;
  mmdbConfigRef?: string;
  zoneCount: number;
}

/** Master switch + geoip source + "Apply now" — the org-level controls row. */
export function GeoDnsControlsCard({ config }: { config?: GeoDnsConfig }): React.JSX.Element {
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
        toast.success(r.summary);
        invalidate();
      },
      onError: onErr,
    }),
  );

  const source = config?.geoipSource ?? 'dbip';

  return (
    <Card className="card-pop border-0">
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

        <GeoipSourcePicker
          source={source}
          maxmindLicenseSecretRef={config?.maxmindLicenseSecretRef}
          mmdbConfigRef={config?.mmdbConfigRef}
        />

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

        {source === 'dbip' ? (
          <p className="text-muted-foreground w-full text-xs">
            IP geolocation by{' '}
            <a
              href="https://db-ip.com"
              target="_blank"
              rel="noreferrer"
              className="underline underline-offset-2"
            >
              DB-IP (db-ip.com)
            </a>
            , CC BY 4.0
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}
