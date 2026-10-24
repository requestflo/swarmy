import * as React from 'react';
import { XIcon } from 'lucide-react';
import { Button } from '@swarmy/ui';
import { InviteLinkPanel, type IssuedInvite } from '@/components/settings/invite-link-panel';
import { InviteForm } from './invite-form';
import type { RoleKey } from './role-lines';

/**
 * "Invite someone" in the aside: the form with its live preview, then the
 * link once the invite exists. Below xl the aside sits under the page, so it
 * scrolls itself into view when it opens.
 */
export function InvitePanel({ callerRole, onClose }: { callerRole: RoleKey; onClose: () => void }): React.JSX.Element {
  const [issued, setIssued] = React.useState<IssuedInvite | null>(null);
  const [round, setRound] = React.useState(0);
  const ref = React.useRef<HTMLElement>(null);
  React.useEffect(() => {
    if (window.matchMedia?.('(max-width: 1279px)').matches) ref.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, []);
  return (
    <section ref={ref} aria-labelledby="invite-title" className="calm-card flex scroll-mt-20 flex-col gap-4 px-5 py-4">
      <div className="flex items-center gap-2">
        <h2 id="invite-title" className="font-display text-[18px] font-bold tracking-[-0.01em]">
          {issued ? 'Invite ready.' : 'Invite someone'}
        </h2>
        <Button variant="ghost" size="icon" className="ml-auto pointer-coarse:size-11" aria-label="Close" onClick={onClose}>
          <XIcon className="size-4" />
        </Button>
      </div>
      {issued ? (
        <>
          <InviteLinkPanel invite={issued} />
          <div className="flex gap-2">
            <Button
              variant="outline"
              className="pointer-coarse:min-h-11"
              onClick={() => {
                setIssued(null);
                setRound((r) => r + 1);
              }}
            >
              Invite another
            </Button>
            <Button variant="ghost" className="pointer-coarse:min-h-11" onClick={onClose}>
              Done
            </Button>
          </div>
        </>
      ) : (
        <InviteForm key={round} callerRole={callerRole} onIssued={setIssued} />
      )}
    </section>
  );
}
