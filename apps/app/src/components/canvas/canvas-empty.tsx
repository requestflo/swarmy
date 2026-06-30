import * as React from 'react';
import { useNavigate } from '@tanstack/react-router';
import { RocketIcon } from 'lucide-react';
import { Button } from '@swarmy/ui';

/** Sell the first deploy — the canvas is empty until a service exists. */
export function CanvasEmpty(): React.JSX.Element {
  const navigate = useNavigate();
  return (
    <div className="mesh flex h-full w-full items-center justify-center p-6">
      <div className="ink-block max-w-lg rounded-3xl p-10 text-center">
        <p className="eyebrow mx-auto">Stacks</p>
        <h2 className="headline mt-4 text-3xl sm:text-4xl">
          Nothing deployed <em>yet</em>.
        </h2>
        <p className="text-ink-foreground/70 mt-3 text-sm">
          Your apps live here as a canvas you can arrange. Deploy your first service to see it appear.
        </p>
        <Button className="mt-6" onClick={() => navigate({ to: '/services/new' })}>
          <RocketIcon className="size-4" /> Deploy a service
        </Button>
      </div>
    </div>
  );
}
