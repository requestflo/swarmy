import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { Section, SectionLink } from '@/components/calm';
import { TextSkeleton } from '@/components/states';
import { useTRPC } from '@/integrations/trpc';
import { listWords } from './connections-model';

/**
 * The app-scoped way into Network › Connections: on an app's Access tab, which
 * other apps can reach its services (connected apps), else that none can.
 */
export function OtherAppsSection({ stack }: { stack: string }): React.JSX.Element {
  const trpc = useTRPC();
  const q = useQuery(trpc.stacks.endpoints.queryOptions({ stack }));
  const peers = q.data?.connectedApps;
  return (
    <Section
      title="Other apps"
      count={peers?.length}
      action={
        <Link to="/network/connections" search={{ app: stack }}>
          <SectionLink>Connections →</SectionLink>
        </Link>
      }
    >
      <p className="text-muted-foreground text-[13.5px]">
        {q.isPending ? (
          <TextSkeleton className="h-3.5 w-72" />
        ) : !peers ? (
          'Couldn’t read which apps can reach it.'
        ) : peers.length === 0 ? (
          `No other app can reach ${stack}’s services. Apps are isolated until you connect them.`
        ) : peers.length === 1 ? (
          `${peers[0]} can reach ${stack}’s services over a private network just for the two of them. Every other app can’t.`
        ) : (
          `${listWords(peers)} can reach ${stack}’s services, each over a private network just for that pair. Every other app can’t.`
        )}
      </p>
    </Section>
  );
}
