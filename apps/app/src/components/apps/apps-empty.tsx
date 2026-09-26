import * as React from 'react';
import { Link } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { Button } from '@swarmy/ui';
import { SayHeader } from '@/components/calm';
import { useCommandPalette } from '@/components/shell/command-palette-provider';
import { useTRPC } from '@/integrations/trpc';

/** Starter templates shown as chips, when the catalogue has them. */
const STARTERS = ['node-api', 'ghost', 'n8n'];

/**
 * No apps yet: the sentence, a few real templates, the page's coral
 * "Deploy an app", and "or just ask" (⌘K). Sells the next action.
 */
export function AppsEmpty({ workspace }: { workspace: string | undefined }): React.JSX.Element {
  const trpc = useTRPC();
  const catalogue = useQuery(trpc.blueprints.list.queryOptions());
  const { toggle } = useCommandPalette();
  const starters = STARTERS.map((id) => catalogue.data?.find((b) => b.id === id && !b.docOnly)).filter(
    (b): b is NonNullable<typeof b> => !!b,
  );
  return (
    <>
      <SayHeader
        eyebrow={workspace ? `Apps · ${workspace}` : 'Apps'}
        title={
          <>
            Nothing deployed yet. <em>Your first app takes about two minutes.</em>
          </>
        }
        lede="Pick a template or bring your own compose file, image or git repo. It gets an address with HTTPS and a nightly backup."
      />
      <div className="border-foreground/15 flex flex-col items-start gap-3.5 rounded-2xl border border-dashed bg-[radial-gradient(var(--border)_1px,transparent_1px)] [background-size:22px_22px] p-5 sm:p-7">
        <div className="flex flex-wrap gap-2">
          {starters.map((b) => (
            <Link
              key={b.id}
              to="/deploy/$template"
              params={{ template: b.id }}
              className="bg-surface-2 text-foreground/85 hover:text-foreground inline-flex h-7 items-center rounded-full px-2.5 text-xs font-semibold dark:bg-accent pointer-coarse:min-h-11"
            >
              {b.name}
            </Link>
          ))}
          <Link
            to="/deploy"
            className="bg-surface-2 text-foreground/85 hover:text-foreground inline-flex h-7 items-center rounded-full px-2.5 text-xs font-semibold dark:bg-accent pointer-coarse:min-h-11"
          >
            From a git repo
          </Link>
        </div>
        <div className="flex flex-wrap gap-2.5">
          <Button asChild className="pointer-coarse:min-h-11">
            <Link to="/deploy">Deploy an app</Link>
          </Button>
          <Button variant="outline" onClick={toggle} className="pointer-coarse:min-h-11">
            <kbd className="bg-surface-2 border-border rounded-md border px-1.5 font-mono text-[11px] leading-4 dark:bg-accent">⌘K</kbd>
            or just ask
          </Button>
        </div>
        <span className="text-muted-foreground font-mono text-[11px]">
          Your apps will show here as one row each, with a map view of where they run.
        </span>
      </div>
    </>
  );
}
