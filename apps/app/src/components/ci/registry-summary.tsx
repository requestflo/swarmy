import * as React from 'react';
import { RowList, Section, Tech } from '@/components/calm';
import { LineRow as CalmRow } from '@/components/rowpage/line-row';
import { bytes, relTime } from '@/lib/format';

interface RegistryView {
  enabled: boolean;
  host: string | null;
  login: string | null;
  authEnforced: boolean;
  online: boolean;
}

/** The canonical in-swarm pull address (`DEFAULT_REGISTRY_HOST`): the routing mesh's port 5000 on every server. */
const MESH_HOST = 'localhost:5000';
/** Mirrors `RegistryUsageView` (registry-usage.ts): measured by the GC tick. */
export interface RegistryUsage {
  sizeBytes: number;
  repos: number;
  images: number;
  measuredAt: string;
  lastGc: { at: string; deleted: number; reclaimedBytes: number | null } | null;
}

function usageTech(u: RegistryUsage): string {
  const measured = `measured ${relTime(u.measuredAt)}`;
  if (!u.lastGc) return measured;
  const freed = u.lastGc.reclaimedBytes !== null ? `freed ${bytes(u.lastGc.reclaimedBytes)}, ` : '';
  return `${measured} · last cleanup ${relTime(u.lastGc.at)}: ${freed}${u.lastGc.deleted} old manifests removed`;
}

/** The in-swarm registry in one glance; its settings are at Controls. */
export function RegistrySummary({
  config,
  credentials,
  usage,
}: {
  config: RegistryView | undefined;
  credentials: number | undefined;
  /** undefined = still loading; null = not measured since the controller started. */
  usage?: RegistryUsage | null;
}): React.JSX.Element {
  return (
    <Section title="Where images live" flush>
      <RowList label="Registries">
        {config ? (
          <CalmRow
            tone={!config.enabled ? 'idle' : config.online ? 'ok' : 'bad'}
            name="Built-in registry"
            sub={config.host ?? undefined}
            say={config.enabled ? (config.authEnforced ? 'Inside your servers, login required' : 'Inside your servers') : 'Off: builds push to an outside registry'}
            tech={`login ${config.login ?? 'none'} · auth ${config.authEnforced ? 'enforced' : 'not enforced'}`}
            word={!config.enabled ? 'Off' : config.online ? 'Online' : 'Offline'}
          />
        ) : null}
        {config?.enabled && usage !== undefined ? (
          <CalmRow
            tone={usage ? 'ok' : 'idle'}
            name="Space used"
            say={usage ? `${bytes(usage.sizeBytes)} for ${usage.images} images in ${usage.repos} repos` : 'Not measured yet. The next cleanup measures it.'}
            tech={usage ? usageTech(usage) : 'measured every 6 hours with the image cleanup'}
          />
        ) : null}
        {credentials !== undefined ? (
          <CalmRow tone={credentials ? 'ok' : 'idle'} name="Outside registries" say={credentials ? `${credentials} saved logins for private images` : 'None saved; public images only'} />
        ) : null}
      </RowList>
      {config?.enabled && config.host === MESH_HOST ? (
        <div className="flex flex-col gap-0.5 pb-3">
          <p className="text-muted-foreground text-[13px]">
            Every server pulls from <span className="text-foreground font-mono">{MESH_HOST}</span> over the swarm network — never public.
          </p>
          <Tech>registry:2 · port 5000 on the routing mesh · each agent drops outside traffic to :5000 (SWARMY-REGISTRY chain) unless SWARMY_REGISTRY_FIREWALL=false</Tech>
        </div>
      ) : null}
    </Section>
  );
}
