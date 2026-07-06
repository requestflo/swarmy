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
  toast,
} from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';

export type GeoipSource = 'dbip' | 'maxmind' | 'file' | 'off';

const GEOIP_SOURCES: Array<{ id: GeoipSource; label: string }> = [
  { id: 'dbip', label: 'DB-IP (built in)' },
  { id: 'maxmind', label: 'MaxMind GeoLite2' },
  { id: 'file', label: 'Custom .mmdb config' },
  { id: 'off', label: 'Off (unsteered)' },
];

interface GeoipSourcePickerProps {
  source: GeoipSource;
  maxmindLicenseSecretRef?: string;
  mmdbConfigRef?: string;
}

/** GeoIP source select + the secret/config ref input the source needs. */
export function GeoipSourcePicker({
  source,
  maxmindLicenseSecretRef,
  mmdbConfigRef,
}: GeoipSourcePickerProps): React.JSX.Element {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const [ref, setRef] = React.useState('');

  const setConfig = useMutation(
    trpc.geodns.setConfig.mutationOptions({
      onSuccess: () => {
        toast.success('Geo-DNS settings saved');
        setRef('');
        void qc.invalidateQueries();
      },
      onError: (e) => toast.error(e.message),
    }),
  );

  const needsRef = source === 'maxmind' || source === 'file';
  const currentRef = source === 'maxmind' ? maxmindLicenseSecretRef : mmdbConfigRef;

  return (
    <>
      <div className="flex items-center gap-2">
        <Label className="mono-label shrink-0">GeoIP</Label>
        <Select
          value={source}
          onValueChange={(v) => setConfig.mutate({ geoipSource: v as GeoipSource })}
        >
          <SelectTrigger className="w-52">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {GEOIP_SOURCES.map((s) => (
              <SelectItem key={s.id} value={s.id}>
                {s.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {needsRef ? (
        <div className="flex items-center gap-2">
          <Input
            value={ref}
            onChange={(e) => setRef(e.target.value)}
            placeholder={currentRef ?? (source === 'maxmind' ? 'license secret ref…' : 'mmdb config ref…')}
            className="h-8 w-48"
          />
          <Button
            variant="outline"
            size="sm"
            disabled={!ref || setConfig.isPending}
            onClick={() =>
              setConfig.mutate(
                source === 'maxmind' ? { maxmindLicenseSecretRef: ref } : { mmdbConfigRef: ref },
              )
            }
          >
            Save
          </Button>
        </div>
      ) : null}
    </>
  );
}
