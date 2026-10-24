import * as React from 'react';
import { KeyRoundIcon } from 'lucide-react';
import { Button, Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@swarmy/ui';
import type { AppEnvironment } from '../gitops-types';
import { envLabel } from '../plan-status';
import { slotsLeft, slotsWords } from './clone-model';
import { SecretSlots } from './secret-slots';

/**
 * On a cloned environment's lane: where it is declared (the dashboard, until
 * swarmy.yaml names it) and its secrets — how many are still empty, and the
 * write-only fields to fill them.
 */
export function DashboardEnvNote({ env }: { env: AppEnvironment }): React.JSX.Element | null {
  const [open, setOpen] = React.useState(false);
  const d = env.dashboard;
  if (!d) return null;
  const left = slotsLeft(d.secretSlots);
  const name = envLabel(env.environment);
  return (
    <div className="flex flex-col gap-1.5">
      <p className="text-tone-info text-[12.5px]">
        Cloned from {d.from}. Lives in the dashboard until you add it to swarmy.yaml.
      </p>
      {d.secretSlots.length ? (
        <Sheet open={open} onOpenChange={setOpen}>
          <div className="flex flex-wrap items-center gap-2">
            <span className={left ? 'text-tone-warn text-[12.5px]' : 'text-muted-foreground text-[12.5px]'}>
              {slotsWords(left, d.secretSlots.length)}
            </span>
            <Button variant="outline" size="sm" className="pointer-coarse:min-h-11" onClick={() => setOpen(true)}>
              <KeyRoundIcon className="size-3.5" /> {left ? 'Fill secrets' : 'Secrets'}
            </Button>
          </div>
          <SheetContent className="w-full overflow-y-auto sm:max-w-lg">
            <SheetHeader>
              <SheetTitle>{name}’s secrets</SheetTitle>
              <SheetDescription>Secrets are never copied between environments; each has its own. Values are write-only.</SheetDescription>
            </SheetHeader>
            <div className="px-4 pb-8">
              <SecretSlots stack={env.stack} env={env.environment} slots={d.secretSlots} />
            </div>
          </SheetContent>
        </Sheet>
      ) : null}
    </div>
  );
}
