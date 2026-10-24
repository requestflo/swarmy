import * as React from 'react';
import { Button, cn } from '@swarmy/ui';
import { Tech } from '@/components/calm';
import { attachEnvLines, type AttachCandidate } from './attach-plan';
import { useAttachBucket } from './use-attach-bucket';

export interface AttachTarget {
  bucketId: string;
  bucket: string;
  app: string;
}

/**
 * "Attach exports to automations?" — the variables swarmy will add, the
 * services that get them, then Attach (toast with Undo) or Cancel / Esc.
 */
export function AttachPreview({
  target,
  candidates,
  endpoint,
  publicEndpoint = null,
  region,
  onClose,
  className,
}: {
  target: AttachTarget;
  candidates: AttachCandidate[];
  endpoint: string | null;
  /** The org's public S3 endpoint (added as S3_PUBLIC_ENDPOINT), when there is one. */
  publicEndpoint?: string | null;
  region: string;
  onClose: () => void;
  className?: string;
}): React.JSX.Element {
  const { attach, pending } = useAttachBucket();
  const eligible = candidates.filter((c) => c.eligible);
  const [picked, setPicked] = React.useState(() => new Set(eligible.map((c) => c.id)));
  const titleId = React.useId();
  const attachRef = React.useRef<HTMLButtonElement>(null);

  // Focus Attach once a picker that opened this has handed focus back.
  React.useEffect(() => {
    const t = window.setTimeout(() => attachRef.current?.focus(), 60);
    return () => window.clearTimeout(t);
  }, []);

  React.useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && !pending) onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, pending]);

  const chosen = eligible.filter((c) => picked.has(c.id));
  const go = async (): Promise<void> => {
    await attach({ bucketId: target.bucketId, bucket: target.bucket, app: target.app, services: chosen });
    onClose();
  };

  return (
    <div role="group" aria-labelledby={titleId} className={cn('calm-next flex flex-col gap-2.5 px-4 py-3.5', className)}>
      <h3 id={titleId} className="text-[14px] font-semibold">
        Attach <span className="font-mono">{target.bucket}</span> to {target.app}?
      </h3>
      <p className="text-muted-foreground text-[13px] leading-relaxed">
        swarmy makes a read-write key for each service you pick and adds these variables. Each one restarts once to pick
        them up; nothing else changes.
      </p>
      <pre className="calm-code overflow-x-auto px-3 py-2.5 text-[11.5px]">
        {attachEnvLines({ endpoint, publicEndpoint, region, bucket: target.bucket }).map((l) => (
          <React.Fragment key={l.key}>
            {l.key}={l.value}
            {l.note ? <span className="opacity-60">{`  # ${l.note}`}</span> : null}
            {'\n'}
          </React.Fragment>
        ))}
      </pre>
      {candidates.length === 0 ? (
        <p className="text-muted-foreground text-[13px]">{target.app} has no services that can take a bucket.</p>
      ) : (
        <fieldset className="flex flex-wrap gap-x-4 gap-y-1.5">
          <legend className="sr-only">Services that get the bucket</legend>
          {candidates.map((c) => (
            <label key={c.id} className={cn('flex items-center gap-2 text-[13px] pointer-coarse:min-h-11', !c.eligible && 'text-muted-foreground')}>
              <input
                type="checkbox"
                className="accent-primary size-4"
                disabled={!c.eligible || pending}
                checked={c.eligible && picked.has(c.id)}
                onChange={(e) =>
                  setPicked((s) => {
                    const n = new Set(s);
                    if (e.target.checked) n.add(c.id);
                    else n.delete(c.id);
                    return n;
                  })
                }
              />
              <span className="font-mono">{c.short}</span>
              {c.reason ? <span className="text-xs">· {c.reason}</span> : null}
            </label>
          ))}
        </fieldset>
      )}
      <Tech>buckets.attachToService × {chosen.length} · scoped key read+write · secret mounted at /run/secrets</Tech>
      <div className="flex flex-wrap items-center gap-2 pt-0.5">
        <Button ref={attachRef} size="sm" disabled={pending || chosen.length === 0} onClick={() => void go()}>
          {pending ? 'Attaching…' : 'Attach'}
        </Button>
        <Button size="sm" variant="outline" disabled={pending} onClick={onClose}>
          Cancel
        </Button>
        <span className="text-muted-foreground ml-auto hidden font-mono text-[11px] pointer-fine:inline">esc cancels</span>
      </div>
    </div>
  );
}
