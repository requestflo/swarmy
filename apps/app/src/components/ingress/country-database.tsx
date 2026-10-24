import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, Input, toast } from '@swarmy/ui';
import { useDepth } from '@/components/calm';
import { Segmented } from '@/components/domains/segmented';
import { useTRPC } from '@/integrations/trpc';
import { useIsAdmin } from './use-is-admin';

type Mode = 'bundled' | 'file' | 'off';

const MODES: Array<{ value: Mode; label: string }> = [
  { value: 'bundled', label: 'Built in' },
  { value: 'file', label: 'My own file' },
  { value: 'off', label: 'Off' },
];

/**
 * Which country database the front door reads for country rules (one setting
 * for the whole workspace): the DB-IP Country Lite bundled in swarmy's Caddy
 * build, an mmdb you put inside the edge container, or off. Admins change it
 * at Controls; everyone sees whether the rules are enforced.
 */
export function CountryDatabase(): React.JSX.Element | null {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const admin = useIsAdmin();
  const controls = useDepth().depth !== 'summary';
  const q = useQuery(trpc.ingress.edgeGeoip.queryOptions());
  const [mode, setMode] = React.useState<Mode | null>(null);
  const [path, setPath] = React.useState('');
  const save = useMutation(
    trpc.ingress.setEdgeGeoip.mutationOptions({
      onSuccess: () => {
        toast.success('Country database saved');
        setMode(null);
        void qc.invalidateQueries({ queryKey: trpc.ingress.edgeGeoip.queryKey() });
      },
      onError: (e) => toast.error(e.message),
    }),
  );
  const v = q.data;
  if (!v) return null;
  const picked = mode ?? v.mode;
  const say =
    v.effectivePath === null
      ? v.source === 'off'
        ? 'Country rules are saved but not enforced — the country database is off.'
        : 'Country rules are saved but not enforced — the front door has no country database.'
      : v.source === 'bundled'
        ? 'Countries come from the built-in DB-IP Country Lite database.'
        : `Countries come from ${v.effectivePath}.`;
  return (
    <div className="border-border flex flex-col gap-1.5 border-t pt-2">
      <p className="text-muted-foreground text-[12px] leading-snug">{say}</p>
      {v.source === 'bundled' ? <p className="text-muted-foreground font-mono text-[11px]">{v.attribution}</p> : null}
      {controls && admin ? (
        <form
          className="flex flex-col gap-1.5"
          onSubmit={(e) => {
            e.preventDefault();
            save.mutate(picked === 'file' ? { mode: 'file', path: path.trim() || v.path || '' } : { mode: picked });
          }}
        >
          <Segmented label="Country database" value={picked} options={MODES} disabled={save.isPending} onChange={setMode} />
          {picked === 'file' ? (
            <Input
              aria-label="Country database file inside the front door"
              placeholder={v.path ?? '/data/geoip/country.mmdb'}
              value={path}
              onChange={(e) => setPath(e.target.value)}
              className="h-8 font-mono text-[12px]"
            />
          ) : null}
          {mode !== null || (picked === 'file' && path.trim()) ? (
            <div className="flex justify-end">
              <Button type="submit" variant="outline" size="sm" disabled={save.isPending}>Save</Button>
            </div>
          ) : null}
        </form>
      ) : null}
    </div>
  );
}
