import * as React from 'react';
import { Link } from '@tanstack/react-router';
import { SparklesIcon } from 'lucide-react';
import { Button } from '@swarmy/ui';
import { Wordmark } from '@/components/wordmark';
import { DemoBanner } from './demo-banner';
import { DEMO_INSTALL_URL } from './site';

/**
 * Stands in for a surface that needs a real controller (a live terminal, a
 * sign-in screen) when the dashboard runs as the public demo.
 */
export function DemoUnavailable({
  title = 'This is a demo',
  children,
}: {
  title?: string;
  children?: React.ReactNode;
}): React.JSX.Element {
  return (
    <div
      data-testid="demo-unavailable"
      className="text-muted-foreground flex flex-col items-center gap-3 p-12 text-center text-sm"
    >
      <SparklesIcon className="text-primary size-6" aria-hidden />
      <p className="text-foreground text-base font-semibold">{title}</p>
      <p className="max-w-md">
        {children ?? 'This needs a real swarmy controller and your own servers. Install swarmy to try it for real.'}
      </p>
      <a href={DEMO_INSTALL_URL} className="text-primary font-medium hover:underline">
        Install swarmy →
      </a>
    </div>
  );
}

/** Full-page version for the routes outside the shell (sign-in, app sign-in). */
export function DemoAuthPage(): React.JSX.Element {
  return (
    <div className="bg-background flex min-h-screen flex-col">
      <DemoBanner />
      <div className="mesh flex flex-1 items-center justify-center p-4">
        <div className="flex flex-col items-center text-center">
          <Wordmark className="text-2xl" />
          <DemoUnavailable title="No sign-in needed">
            This is a demo, so there are no accounts. Everything runs in your browser on fake data.
          </DemoUnavailable>
          <Button asChild>
            <Link to="/">Open the dashboard</Link>
          </Button>
        </div>
      </div>
    </div>
  );
}
