import * as React from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Button, Input, cn, toast } from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';

/** Where swarmy-dns gets visitor locations (`geodns.setConfig` geoipSource). */
export type GeoipSource = 'dbip' | 'maxmind' | 'file' | 'off';

/** The location sources swarmy-dns can read (`geodns.setConfig` geoipSource). */
const PICKS: Array<{ id: GeoipSource; title: string; what: string }> = [
  { id: 'dbip', title: 'DB-IP Lite · built in', what: 'downloaded on each DNS server, nothing to set up' },
  { id: 'maxmind', title: 'MaxMind GeoLite2', what: 'a free licence key, kept as a secret, for better city accuracy' },
  { id: 'file', title: 'From a file', what: 'your own .mmdb in a Docker config, for air-gapped swarms' },
  { id: 'off', title: 'Off', what: 'no locations: every visitor gets the same order' },
];

/** "DB-IP Lite, built in" — for the Summary sentence. */
export const SOURCE_WORDS: Record<GeoipSource, string> = {
  dbip: 'DB-IP Lite, built in',
  maxmind: 'MaxMind GeoLite2',
  file: 'your own location file',
  off: 'nowhere',
};

/** Location data picks, plus the secret / config reference MaxMind and a file need. */
export function LocationPicks({ source, maxmindLicenseSecretRef, mmdbConfigRef }: { source: GeoipSource; maxmindLicenseSecretRef?: string; mmdbConfigRef?: string }): React.JSX.Element {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const [ref, setRef] = React.useState('');
  const save = useMutation(
    trpc.geodns.setConfig.mutationOptions({
      onSuccess: () => {
        toast.success('Location data saved');
        setRef('');
        void qc.invalidateQueries();
      },
      onError: (e) => toast.error(e.message),
    }),
  );
  const needsRef = source === 'maxmind' || source === 'file';
  const current = source === 'maxmind' ? maxmindLicenseSecretRef : mmdbConfigRef;
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-[12.5px] font-semibold">Location data</span>
      <div role="group" aria-label="Location data" className="grid gap-1.5">
        {PICKS.map((p) => (
          <button
            key={p.id}
            type="button"
            aria-pressed={source === p.id}
            disabled={save.isPending}
            onClick={() => source !== p.id && save.mutate({ geoipSource: p.id })}
            className={cn(
              'flex min-h-11 flex-col items-start gap-0.5 rounded-[12px] border px-3 py-2 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring/60',
              source === p.id ? 'border-primary/60 bg-surface-2 dark:bg-accent' : 'border-border hover:border-foreground/25',
            )}
          >
            <span className="text-[12.5px] font-semibold">{p.title}</span>
            <span className="text-muted-foreground text-[11.5px]">{p.what}</span>
          </button>
        ))}
      </div>
      {needsRef ? (
        <div className="flex flex-wrap items-center gap-2">
          <Input
            aria-label={source === 'maxmind' ? 'Licence key secret reference' : 'Location file config reference'}
            value={ref}
            onChange={(e) => setRef(e.target.value)}
            placeholder={current ?? (source === 'maxmind' ? 'secret reference' : 'Docker config reference')}
            className="h-8 min-w-40 flex-1 font-mono text-[12px]"
          />
          <Button
            variant="outline"
            size="sm"
            disabled={!ref.trim() || save.isPending}
            onClick={() => save.mutate(source === 'maxmind' ? { maxmindLicenseSecretRef: ref.trim() } : { mmdbConfigRef: ref.trim() })}
          >
            Save
          </Button>
        </div>
      ) : null}
    </div>
  );
}
