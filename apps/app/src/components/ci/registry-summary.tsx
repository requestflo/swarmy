import * as React from 'react';
import { RowList, Section } from '@/components/calm';
import { LineRow as CalmRow } from '@/components/rowpage/line-row';

interface RegistryView {
  enabled: boolean;
  host: string | null;
  login: string | null;
  authEnforced: boolean;
  online: boolean;
}

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
    </Section>
  );
}
