import * as React from 'react';
import { UploadIcon } from 'lucide-react';
import { Button, Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@swarmy/ui';
import { BundleUploadForm } from './bundle-upload-form';
import { ImportManifestForm } from './import-manifest-form';

type Mode = 'bundle' | 'manifest';

/**
 * For clusters without internet access: the whole offline bundle (default),
 * or only its signed manifest when the images are already in the registry.
 */
export function ImportReleaseButton(): React.JSX.Element {
  const [open, setOpen] = React.useState(false);
  const [mode, setMode] = React.useState<Mode>('bundle');
  const close = () => setOpen(false);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <Button size="sm" variant="outline" onClick={() => setOpen(true)}>
        <UploadIcon className="size-3.5" /> Import release
      </Button>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Import a release</DialogTitle>
          <DialogDescription>
            For clusters without internet access. swarmy checks the release against its signing key before anything is copied or
            stored, so a file that isn&apos;t a real swarmy release does nothing.
          </DialogDescription>
        </DialogHeader>
        <ModeSwitch mode={mode} onChange={setMode} />
        {mode === 'bundle' ? <BundleUploadForm onDone={close} /> : <ImportManifestForm onDone={close} />}
      </DialogContent>
    </Dialog>
  );
}

function ModeSwitch({ mode, onChange }: { mode: Mode; onChange: (m: Mode) => void }): React.JSX.Element {
  const opts: Array<{ id: Mode; label: string }> = [
    { id: 'bundle', label: 'The bundle (.tar)' },
    { id: 'manifest', label: 'Only platform.json + .sig' },
  ];
  return (
    <div role="group" aria-label="What to import" className="flex flex-wrap gap-1.5">
      {opts.map((o) => (
        <Button
          key={o.id}
          size="sm"
          variant={mode === o.id ? 'secondary' : 'ghost'}
          aria-pressed={mode === o.id}
          className="pointer-coarse:min-h-11"
          onClick={() => onChange(o.id)}
        >
          {o.label}
        </Button>
      ))}
    </div>
  );
}
