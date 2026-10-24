import * as React from 'react';
import { RowList, Section, Tech } from '@/components/calm';
import { LineRow as CalmRow } from '@/components/rowpage/line-row';

interface RegistryView {
  enabled: boolean;
  host: string | null;
  login: string | null;
  authEnforced: boolean;
  online: boolean;
}

/** The canonical in-swarm pull address (`DEFAULT_REGISTRY_HOST`): the routing mesh's port 5000 on every server. */
const MESH_HOST = 'localhost:5000';

/** The in-swarm registry in one glance; its settings are at Controls. */
export function RegistrySummary({ config, credentials }: { config: RegistryView | undefined; credentials: number | undefined }): React.JSX.Element {
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
