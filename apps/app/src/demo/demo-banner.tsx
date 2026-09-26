import * as React from 'react';
import { SparklesIcon } from 'lucide-react';
import { enterFreshDemo, isFreshDemo, leaveFreshDemo } from './fresh';
import { DEMO_INSTALL_URL, DEMO_SITE_URL } from './site';

/**
 * A slim strip shown on every screen in demo mode: says plainly that the data is
 * fake and nothing is saved, and links back to the marketing site and the install
 * docs, plus a quiet switch to the first-run screen (`?fresh=1`) and back.
 * Rendered above the command bar by AppShell, and by the demo notice pages
 * that replace the sign-in screens.
 */
export function DemoBanner(): React.JSX.Element {
  const fresh = isFreshDemo();
  return (
    <div
      role="status"
      data-testid="demo-banner"
      className="bg-ink text-ink-foreground relative z-40 flex flex-wrap items-center justify-center gap-x-3 gap-y-1 px-4 py-2 text-center text-xs sm:text-sm"
    >
      <span className="inline-flex items-center gap-2">
        <SparklesIcon className="text-primary size-4" aria-hidden />
        <span>
          <strong className="font-bold">Demo</strong>: data is fake, nothing is saved.
        </span>
      </span>
      <button
        type="button"
        onClick={fresh ? leaveFreshDemo : enterFreshDemo}
        className="text-ink-foreground/75 hover:text-ink-foreground underline-offset-2 hover:underline pointer-coarse:min-h-11"
      >
        {fresh ? 'Back to the full demo' : 'See the first-run screen'}
      </button>
      <a href={DEMO_SITE_URL} className="underline-offset-2 hover:underline">
        swarmy.dev
      </a>
      <a
        href={DEMO_INSTALL_URL}
        className="bg-primary text-primary-foreground shrink-0 rounded-full px-3 py-1 text-xs font-bold transition-transform hover:scale-[1.03]"
      >
        Install swarmy →
      </a>
    </div>
  );
}
