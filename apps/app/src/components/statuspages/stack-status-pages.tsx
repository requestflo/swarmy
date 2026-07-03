import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { PlusIcon, RadioTowerIcon, XIcon } from 'lucide-react';
import {
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Collapsible,
  CollapsibleContent,
  EmptyState,
  Skeleton,
} from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';
import { StackStatusPageRow } from './stack-status-page-row';
import { StatusPageInlineForm } from './status-page-inline-form';

interface StackStatusPagesProps {
  stack: string;
  /** Whether the observability suite is on — steers who gets the coral CTA. */
  suiteEnabled: boolean;
}

/**
 * This stack's public status page(s): list with public URL + custom domain up
 * front, an inline expanding create card (components preselected from the
 * stack), row-expand edit, and AlertDialog-confirmed delete.
 */
export function StackStatusPages({ stack, suiteEnabled }: StackStatusPagesProps): React.JSX.Element {
  const trpc = useTRPC();
  const [creating, setCreating] = React.useState(false);
  const pages = useQuery({
    ...trpc.statusPages.list.queryOptions({ stack }),
    refetchInterval: 15_000,
  });
  const rows = pages.data ?? [];

  return (
    <Card className="card-pop border-0">
      <CardHeader>
        <CardTitle className="flex items-center justify-between gap-3 text-base">
          <span className="flex items-center gap-2">
            <RadioTowerIcon className="size-4" /> Status page
          </span>
          {rows.length > 0 ? (
            <Button variant="outline" size="sm" onClick={() => setCreating((v) => !v)}>
              {creating ? <XIcon className="size-4" /> : <PlusIcon className="size-4" />}
              {creating ? 'Close' : 'New status page'}
            </Button>
          ) : null}
        </CardTitle>
        <CardDescription>
          A public page your users can trust — live status for {stack}&apos;s components, 90-day
          uptime bars and incident history, at /s/&lt;slug&gt; or your own domain.
        </CardDescription>
      </CardHeader>
      <CardContent className="p-0">
        <Collapsible open={creating} onOpenChange={setCreating}>
          <CollapsibleContent>
            <div className="bg-accent/30 border-t px-6 py-5">
              <StatusPageInlineForm
                stack={stack}
                onDone={() => setCreating(false)}
                onCancel={() => setCreating(false)}
              />
            </div>
          </CollapsibleContent>
        </Collapsible>

        {pages.isLoading ? (
          <div className="space-y-2 px-6 pb-6">
            <Skeleton className="h-12 w-full rounded-xl" />
            <Skeleton className="h-12 w-2/3 rounded-xl" />
          </div>
        ) : pages.isError ? (
          <EmptyState
            className="mx-6 mb-6"
            icon={<RadioTowerIcon />}
            title="Couldn't load status pages"
            description={pages.error.message}
            action={
              <Button variant="outline" size="sm" onClick={() => void pages.refetch()}>
                Retry
              </Button>
            }
          />
        ) : rows.length === 0 && !creating ? (
          <EmptyState
            className="mx-6 mb-6"
            icon={<RadioTowerIcon />}
            title={`No status page for ${stack} yet`}
            description="Create one — its components are preselected from this stack, and you get a shareable public link the moment you hit create."
            action={
              <Button
                variant={suiteEnabled ? 'default' : 'outline'}
                size="sm"
                onClick={() => setCreating(true)}
              >
                <PlusIcon className="size-4" /> Create status page
              </Button>
            }
          />
        ) : (
          <div className="border-t">
            {rows.map((page) => (
              <StackStatusPageRow key={page.id} page={page} stack={stack} />
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
