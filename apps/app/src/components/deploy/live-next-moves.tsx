import * as React from 'react';
import { Link } from '@tanstack/react-router';
import { GlobeIcon, WorkflowIcon } from 'lucide-react';

function MoveCard({ icon, title, sub }: { icon: React.ReactNode; title: string; sub: string }): React.JSX.Element {
  return (
    <>
      <span aria-hidden className="bg-muted text-foreground flex size-10 shrink-0 items-center justify-center rounded-xl">
        {icon}
      </span>
      <span className="flex min-w-0 flex-col gap-0.5">
        <span className="font-display text-[15px] font-bold tracking-[-0.01em]">{title}</span>
        <span className="text-muted-foreground text-[12.5px]">{sub}</span>
      </span>
    </>
  );
}

const CARD = 'calm-card hover:border-foreground/25 flex min-h-11 items-center gap-3 px-4 py-3.5 transition-colors motion-reduce:transition-none';

/**
 * "Next moves": your own domain (the app's Domains tab, add form open) and
 * the app itself (its Overview canvas). Either one leaves this screen for good.
 */
export function LiveNextMoves({
  stack,
  parts,
  onLeave,
}: {
  stack: string;
  /** "wordpress + db" — the parts the canvas will show. */
  parts: string;
  onLeave: () => void;
}): React.JSX.Element {
  return (
    <section aria-labelledby="next-moves" className="flex flex-col gap-3">
      <h2 id="next-moves" className="calm-eyebrow">
        Next moves
      </h2>
      <div className="grid gap-3 sm:grid-cols-2">
        <Link to="/stacks/$name/network" params={{ name: stack }} search={{ add: '' }} onClick={onLeave} className={CARD}>
          <MoveCard icon={<GlobeIcon className="size-4" />} title="Point your own domain" sub="Add it here, then one DNS record" />
        </Link>
        <Link to="/stacks/$name" params={{ name: stack }} search={{}} onClick={onLeave} className={CARD}>
          <MoveCard icon={<WorkflowIcon className="size-4" />} title="Open the app" sub={`See ${parts}, logs and metrics`} />
        </Link>
      </div>
    </section>
  );
}
