import * as React from 'react';
import { Link } from '@tanstack/react-router';
import { Button } from '@swarmy/ui';
import { CalmPage, Depth, NextAction, Say, SayHeader } from '@/components/calm';
import { useAwaitNode } from './use-await-node';
import { useJoinLink } from './use-join-link';
import { needsHttps } from './install-command-panel';
import { InstallLine } from './install-line';
import { JoinOptions } from './join-options';
import { AddServerCode } from './add-server-code';
import { ArrivalReceipt } from './arrival-receipt';
import { PhoneHomeRadar, PhoneHomeWaiting } from './phone-home-radar';
import { PlatformTabs } from './platform-tabs';
import type { PlatformId } from './platforms';
import type { NodeRoleChoice } from './node-role-picker';

/**
 * Add a server (board 12): where it is (platform tabs: the same line, or
 * cloud-config for a cloud), one line front and centre, what's already
 * handled, and the radar — your servers as blips — until it phones home and
 * the receipt lands. Nothing is minted until "Create join link" (an unexpired
 * link from this tab is reused). Role, labels and a named link at Controls;
 * the raw token at Code. With no HTTPS address the page asks for a domain.
 */
export function AddServerPage(): React.JSX.Element {
  const { link, pending, failed, mint } = useJoinLink();
  const [role, setRole] = React.useState<NodeRoleChoice>('auto');
  const [labels, setLabels] = React.useState('');
  const [platform, setPlatform] = React.useState<PlatformId>('linux');
  const { arrived, nodes } = useAwaitNode(link?.id ?? null);
  const blocked = needsHttps(link?.target);

  return (
    <CalmPage
      crumbs={[{ label: 'Servers', to: '/nodes' }, { label: 'Add a server' }]}
      aside={
        blocked ? null : (
          <>
            <AddServerCode link={link} role={role} labels={labels} platform={platform} />
            <section aria-live="polite" aria-label="New server" className="calm-card flex flex-col items-center gap-5 px-5 py-6">
              <PhoneHomeRadar nodes={nodes} sweeping={link !== null && !arrived} arrivedId={arrived?.node.id ?? null} />
              {arrived ? <ArrivalReceipt arrived={arrived} role={role} onAnother={() => mint()} /> : <PhoneHomeWaiting armed={link !== null} />}
            </section>
          </>
        )
      }
    >
      <SayHeader
        eyebrow="Any machine, anywhere: cloud, office, or a box under your desk"
        title={
          blocked ? (
            <>
              Adding a server <Say tone="warn">needs HTTPS.</Say>
            </>
          ) : (
            'Run one line on the new server.'
          )
        }
        lede={
          blocked
            ? `New servers only install from an https:// address, and this dashboard is on ${link?.target?.url ?? 'plain http'}. Give it a domain and the line appears here.`
            : 'It installs what it needs, dials home over HTTPS and joins your servers. Nothing to open on your firewall.'
        }
      />
      {blocked ? null : <PlatformTabs value={platform} onChange={setPlatform} />}
      {blocked ? (
        <NextAction
          title="Set a dashboard domain"
          tech={`install target ${link?.target?.url ?? ''} · http:// is refused by the loader and installer`}
          actions={
            <Button asChild className="pointer-coarse:min-h-11">
              <Link to="/ingress">Set a dashboard domain</Link>
            </Button>
          }
        >
          Point a domain at this dashboard in Network → Edge. swarmy gets the certificate, then this page shows the
          install line.
        </NextAction>
      ) : failed ? (
        <NextAction
          tone="bad"
          title="Couldn't make a join link."
          actions={
            <Button onClick={() => mint()} disabled={pending} className="pointer-coarse:min-h-11">
              Try again
            </Button>
          }
        />
      ) : link ? (
        <InstallLine link={link} role={role} labels={labels} platform={platform} done={arrived !== null} />
      ) : (
        <NextAction
          tone="info"
          title="Make a join link for the new server."
          tech="nodes.generateJoinToken · single use · expires in 1 h"
          actions={
            <Button onClick={() => mint()} disabled={pending} className="pointer-coarse:min-h-11">
              {pending ? 'Making…' : 'Create join link'}
            </Button>
          }
        >
          It works once and expires in an hour. The line to paste appears here.
        </NextAction>
      )}
      {blocked ? null : (
        <Depth at="controls">
          <JoinOptions role={role} onRoleChange={setRole} labels={labels} onLabelsChange={setLabels} onRemint={mint} pending={pending} />
        </Depth>
      )}
    </CalmPage>
  );
}
