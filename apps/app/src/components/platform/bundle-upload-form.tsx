import * as React from 'react';
import { Button, Label, Progress, cn } from '@swarmy/ui';
import { Tech } from '@/components/calm';
import { bundlePercent, bundleWords, sizeWords } from './bundle-words';
import { useBundleUpload } from './use-bundle-upload';

/**
 * The whole offline bundle (`swarmy-<ver>.tar`): sent to the controller,
 * signature checked, every image copied into the built-in registry, then the
 * release is offered like one from the feed.
 */
export function BundleUploadForm({ onDone }: { onDone: () => void }): React.JSX.Element {
  const [file, setFile] = React.useState<File | null>(null);
  const { state, busy, start } = useBundleUpload();
  const done = state?.phase === 'done';
  return (
    <div className="grid gap-3">
      <Label htmlFor="imp-bundle">Bundle file</Label>
      <input
        id="imp-bundle"
        type="file"
        accept=".tar,application/x-tar"
        disabled={busy}
        onChange={(e) => setFile(e.target.files?.[0] ?? null)}
        className="text-xs"
      />
      {file && !state ? (
        <p className="text-muted-foreground text-[13px]">
          {file.name} · {sizeWords(file.size)}. Your browser sends it to swarmy; keep this page open until it says done.
        </p>
      ) : null}
      {state ? (
        <div className="grid gap-1.5" aria-live="polite">
          <Progress value={bundlePercent(state)} aria-label="Bundle progress" />
          <p className={cn('text-[13px]', state.phase === 'failed' ? 'text-tone-bad' : done ? 'text-tone-ok' : 'text-muted-foreground')}>
            {bundleWords(state)}
          </p>
        </div>
      ) : null}
      <Tech>
        platform.bundle.begin → chunk × n → finish → status · images land at
        &lt;registry&gt;/swarmy-system/&lt;host&gt;/&lt;path&gt;:&lt;tag&gt; with swarmy.mirror.* labels
      </Tech>
      <div className="flex justify-end gap-2">
        {done ? (
          <Button onClick={onDone}>Close</Button>
        ) : (
          <Button onClick={() => file && void start(file)} disabled={!file || busy}>
            {busy ? 'Loading…' : state?.phase === 'failed' ? 'Try again' : 'Verify and load'}
          </Button>
        )}
      </div>
    </div>
  );
}
