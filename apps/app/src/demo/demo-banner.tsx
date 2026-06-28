import * as React from 'react';
import { SparklesIcon } from 'lucide-react';
import { exitDemo } from './is-demo';

/**
 * A slim strip shown only in demo mode: tells visitors it's a sandbox and offers
 * the one real CTA out of the demo. Rendered above the command bar by AppShell.
 */
export function DemoBanner(): React.JSX.Element {
  return (
    <div className="bg-ink text-ink-foreground relative z-40 flex items-center justify-center gap-3 px-4 py-2 text-center text-xs sm:text-sm">
      <span className="inline-flex items-center gap-2">
        <SparklesIcon className="text-primary size-4" />
        <span>
          You're exploring a <strong className="font-bold">live demo</strong> — everything's interactive, data is
          local and resets on refresh.
        </span>
      </span>
      <a
        href="/login"
        onClick={exitDemo}
        className="bg-primary text-primary-foreground shrink-0 rounded-full px-3 py-1 text-xs font-bold transition-transform hover:scale-[1.03]"
      >
        Get swarmy →
      </a>
    </div>
  );
}
