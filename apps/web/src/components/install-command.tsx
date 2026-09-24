import { CopyButton } from '@swarmy/ui/components/copy-button';
import { INSTALL_COMMAND } from '@/lib/site';

/** The one-line install, with a copy button. Horizontally scrolls on narrow screens. */
export function InstallCommand({ className }: { className?: string }) {
  return (
    <div
      className={`ink-block flex items-center gap-3 rounded-2xl border border-white/10 py-2 pr-2 pl-5 text-left ${className ?? ''}`}
    >
      <span className="text-primary mono-data select-none" aria-hidden>
        $
      </span>
      <code className="mono-data min-w-0 flex-1 overflow-x-auto py-2 text-sm whitespace-nowrap [scrollbar-width:none]">
        {INSTALL_COMMAND}
      </code>
      <CopyButton value={INSTALL_COMMAND} label="Copy" className="shrink-0" />
    </div>
  );
}
