import * as React from 'react';
import { BoxesIcon } from 'lucide-react';
import { AddAppDialog } from '@/components/stacks/add-app-dialog';

interface StackAddServiceCardProps {
  stack: string;
}

/** Services section: grow the stack in place via the inline expanding form. */
export function StackAddServiceCard({ stack }: StackAddServiceCardProps): React.JSX.Element {
  return (
    <section className="card-pop p-5">
      <div className="flex items-center gap-3">
        <span className="bg-muted text-muted-foreground flex size-9 items-center justify-center rounded-lg">
          <BoxesIcon className="size-5" />
        </span>
        <div>
          <p className="font-semibold">Services</p>
          <p className="text-muted-foreground text-xs">
            New services land in the <span className="mono-data">{stack}</span> namespace and show
            up on every tab.
          </p>
        </div>
      </div>
      <div className="mt-4">
        <AddAppDialog stack={stack} label="Add a service" />
      </div>
    </section>
  );
}
