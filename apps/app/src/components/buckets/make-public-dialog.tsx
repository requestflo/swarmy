import * as React from 'react';
import { GlobeIcon } from 'lucide-react';
import { Button, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, Input } from '@swarmy/ui';
import { Tech } from '@/components/calm';

interface MakePublicDialogProps {
  open: boolean;
  bucket: string;
  /** Where it will answer: https://<public S3 domain>/<bucket>. */
  address: string | null;
  pending: boolean;
  error: string | null;
  onConfirm: (typed: string) => void;
  onCancel: () => void;
}

/**
 * Making a bucket public names the risk and asks for the bucket's name
 * typed back (`buckets.setAccess` refuses PUBLIC without it). Only admins
 * reach this switch, so it's a confirmation, not a request to someone else.
 */
export function MakePublicDialog({ open, bucket, address, pending, error, onConfirm, onCancel }: MakePublicDialogProps): React.JSX.Element {
  const [typed, setTyped] = React.useState('');
  React.useEffect(() => setTyped(''), [open]);
  const ready = typed.trim() === bucket;
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onCancel()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <GlobeIcon className="text-tone-warn size-5" />
            Put {bucket} on the internet?
          </DialogTitle>
          <DialogDescription>
            Anyone online can reach its address{address ? <> at <span className="font-mono">{address}</span></> : null}. Every request still needs a key
            or a signed link, so nothing is open to read, but any key or signed link for this bucket that leaks would then work from anywhere,
            not only inside your servers.
          </DialogDescription>
        </DialogHeader>
        <ul className="text-muted-foreground list-disc space-y-1 pl-5 text-[13px]">
          <li>Check which keys can read or write it (Access keys, below) and revoke any you don’t need.</li>
          <li>Prefer short-lived signed links for files you share.</li>
          <li>You can put it back to Internal at any time; the change is audited with your name.</li>
        </ul>
        <label className="block space-y-1.5 text-sm">
          <span>
            Type <b className="font-mono">{bucket}</b> to make it public
          </span>
          <Input value={typed} onChange={(e) => setTyped(e.target.value)} autoFocus className="font-mono" aria-label={`Type ${bucket} to confirm`} />
        </label>
        {error ? <p className="text-tone-bad text-sm">{error}</p> : null}
        <Tech>buckets.setAccess {'{'} mode: "PUBLIC", confirm: "{bucket}" {'}'} · the edges route it on the next render</Tech>
        <DialogFooter>
          <Button variant="ghost" onClick={onCancel}>
            Keep it private
          </Button>
          <Button disabled={!ready || pending} onClick={() => onConfirm(typed.trim())}>
            {pending ? 'Making it public…' : 'Make it public'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
