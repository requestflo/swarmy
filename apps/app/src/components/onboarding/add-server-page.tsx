import * as React from 'react';
import { Link } from '@tanstack/react-router';
import { Button } from '@swarmy/ui';
import { CalmPage, Depth, NextAction, Say, SayHeader } from '@/components/calm';
import { useAwaitNode } from './use-await-node';
import { useJoinLink } from './use-join-link';
import { needsHttps } from './install-command-panel';
import { InstallLine } from './install-line';
import { JoinOptions } from './join-options';
import { AwaitServerCard } from './await-server-card';
import { AddServerCode } from './add-server-code';
import type { NodeRoleChoice } from './node-role-picker';

/**
 * Add a server (canvas "AddServer"): one line front and centre, what's
 * already handled, and the waiting pulse. Role, labels and a named link live
 * at Controls (Automatic by default); the raw token at Code. With no HTTPS
 * address the line would be refused, so the page asks for a domain instead.
 */
export function AddServerPage(): React.JSX.Element {
  const { link, pending, failed, mint } = useJoinLink();
  const [role, setRole] = React.useState<NodeRoleChoice>('auto');
  const [labels, setLabels] = React.useState('');
  const arrived = useAwaitNode(link !== null);
  const blocked = link !== null && needsHttps(link.target);

  return (
    <CalmPage
      crumbs={[{ label: 'Servers', to: '/nodes' }, { label: 'Add a server' }]}
      aside={
        <>
          {blocked ? null : <AddServerCode link={link} role={role} labels={labels} />}
          {blocked ? null : <AwaitServerCard armed={link !== null} arrived={arrived} />}
        </>
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
      ) : (
        <InstallLine link={link} role={role} labels={labels} done={arrived !== null} />
      )}
      {blocked ? null : (
        <Depth at="controls">
          <JoinOptions role={role} onRoleChange={setRole} labels={labels} onLabelsChange={setLabels} onRemint={mint} pending={pending} />
        </Depth>
      )}
    </CalmPage>
  );
}
