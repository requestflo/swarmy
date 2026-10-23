import * as React from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Button, Input, toast } from '@swarmy/ui';
import { Tech } from '@/components/calm';
import { Segmented, type SegOption } from '@/components/service-settings/settings-row';
import { useTRPC } from '@/integrations/trpc';

const WINDOWS: SegOption<number>[] = [
  { value: 5, label: '5 min' },
  { value: 15, label: '15 min' },
  { value: 30, label: '30 min' },
];

/**
 * Start the canary (board AppRollout): the version to try, how long to
 * watch it, and the one button. The share and the error ceiling come from
 * the chips above; the deploy-canary worker promotes or puts it back.
 */
export function CanaryStartRow({
  stack,
  service,
  name,
  currentImage,
  pct,
  tripPct,
  windowMin,
  onWindow,
}: {
  stack: string;
  service: string;
  name: string;
  currentImage: string;
  pct: number;
  tripPct: number;
  windowMin: number;
  onWindow: (m: number) => void;
}): React.JSX.Element {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const [image, setImage] = React.useState(currentImage);
  React.useEffect(() => setImage(currentImage), [currentImage]);
  const start = useMutation(
    trpc.releases.startCanary.mutationOptions({
      onSuccess: () => {
        toast.success(`Trying ${image.trim()} on ${pct}% of ${name}’s visitors`);
        void qc.invalidateQueries();
      },
      onError: (e) => toast.error(e.message),
    }),
  );
  const candidate = image.trim();
  const fresh = candidate.length > 0 && candidate !== currentImage;
  return (
    <div className="border-border flex flex-col gap-2.5 border-t pt-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <span className="text-muted-foreground text-[12.5px]">Watch it for</span>
        <Segmented label="Watch the canary for" options={WINDOWS} value={windowMin} onChange={onWindow} mono />
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Input
          aria-label="Version to try"
          value={image}
          onChange={(e) => setImage(e.target.value)}
          placeholder="ghcr.io/acme/web:1.4.0-rc.1"
          className="min-w-0 flex-1 basis-64 font-mono text-[13px] pointer-coarse:min-h-11"
        />
        <Button
          disabled={!fresh || start.isPending}
          className="pointer-coarse:min-h-11"
          onClick={() => start.mutate({ stack, service, image: candidate, trafficPct: pct, durationMin: windowMin, rollbackOnErrorRatePct: tripPct })}
        >
          {start.isPending ? 'Starting…' : `Try it on ${pct}%`}
        </Button>
      </div>
      <p className="text-muted-foreground text-[12.5px]">
        {fresh
          ? `A clean ${windowMin} min makes it the version everyone gets; errors past ${tripPct}% or a copy that won’t start put ${name} back as it was.`
          : `Type the new version’s image to try it. ${name} runs ${currentImage || 'its current image'} today.`}
      </p>
      <Tech>
        releases.startCanary · {service}--canary · 1 copy · trafficPct {pct} · durationMin {windowMin} · rollbackOnErrorRatePct {tripPct}
      </Tech>
    </div>
  );
}
