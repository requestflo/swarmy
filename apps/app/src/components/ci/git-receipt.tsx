import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { CheckCircle2Icon, HourglassIcon, TriangleAlertIcon, XIcon } from 'lucide-react';
import { Button, cn } from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';
import { appCreatedHead } from './git-manifest';
import { hostOf } from './git-providers';
import type { GitResultSearch } from './git-result-banner';
import { KIND_LABEL, type GitConnection } from './git-types';

export interface GitRoundTrip extends GitResultSearch {
  /** The GitHub host whose App this trip registered. */
  created?: string;
}

/**
 * Back from the provider, inside the wizard: "App #41 created on
 * github.northwind.dev" over "swarmy-northwind · private key stored
 * encrypted · webhook secret set, shown never · installed on northwind" — or
 * plainly connected / requested / what went wrong.
 */
export function GitReceipt({
  trip,
  conns,
  onDismiss,
}: {
  trip: GitRoundTrip;
  conns: GitConnection[];
  onDismiss: () => void;
}): React.JSX.Element {
  const trpc = useTRPC();
  const conn = conns.find((c) => c.id === trip.connection);
  const created = trip.git === 'connected' && trip.kind === 'github' ? trip.created : undefined;
  const app = useQuery({
    ...trpc.gitConnections.githubApp.queryOptions(created && created !== 'https://github.com' ? { webBase: created } : undefined),
    enabled: Boolean(created),
  });
  const who = conn?.account ?? conn?.displayName;
  const registered = app.data?.registered ? app.data : undefined;
  const appName = registered ? (registered.name ?? registered.slug) : null;
  // With the number in the headline, the name moves to the facts line.
  const facts = [registered?.appId ? appName : null, 'private key stored encrypted', 'webhook secret set, shown never', who ? `installed on ${who}` : null];

  const [Icon, tone, head, sub] =
    trip.git === 'error'
      ? [TriangleAlertIcon, 'text-tone-bad', 'That didn’t connect.', trip.message ?? 'Try again from the card above.']
      : trip.git === 'requested'
        ? [HourglassIcon, 'text-tone-info', 'Install requested.', 'An owner of that GitHub org needs to approve swarmy — it shows up here once they do.']
        : created
          ? [
              CheckCircle2Icon,
              'text-tone-ok',
              appCreatedHead(registered ? { appId: registered.appId, name: appName } : undefined, hostOf(created)),
              facts.filter(Boolean).join(' · '),
            ]
          : [CheckCircle2Icon, 'text-tone-ok', `${trip.kind ? KIND_LABEL[trip.kind] : 'Your git provider'} is connected${who ? ` · ${who}` : ''}.`, 'Pick a repo below.'];

  return (
    <div role="status" className="calm-card flex items-start gap-3 px-4 py-3">
      <Icon aria-hidden className={cn('mt-0.5 size-5 shrink-0', tone)} />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className={cn('text-[14px] font-semibold', tone)}>{head}</span>
        <span className="text-muted-foreground font-mono text-[11.5px] leading-relaxed">{sub}</span>
      </div>
      <Button variant="ghost" size="icon" aria-label="Dismiss" className="pointer-coarse:size-11" onClick={onDismiss}>
        <XIcon className="size-4" />
      </Button>
    </div>
  );
}
