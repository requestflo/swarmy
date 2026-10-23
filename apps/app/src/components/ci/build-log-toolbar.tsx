import * as React from 'react';
import { CheckIcon, CopyIcon } from 'lucide-react';
import { Button, cn } from '@swarmy/ui';

interface BuildLogToolbarProps {
  follow: boolean;
  onFollow: (on: boolean) => void;
  warningsOnly: boolean;
  onWarningsOnly: (on: boolean) => void;
  /** The text Copy puts on the clipboard (what's shown). */
  text: string;
  meta: string;
}

/** Follow · Only warnings · Copy, over the log (board 27). */
export function BuildLogToolbar({ follow, onFollow, warningsOnly, onWarningsOnly, text, meta }: BuildLogToolbarProps): React.JSX.Element {
  const [copied, setCopied] = React.useState(false);
  const copy = (): void => {
    void navigator.clipboard?.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };
  const toggle = (on: boolean): string => cn('pointer-coarse:min-h-11', on && 'bg-accent text-foreground');
  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="text-muted-foreground mr-auto font-mono text-[11.5px]">{meta}</span>
      <Button variant="outline" size="sm" className={toggle(follow)} aria-pressed={follow} onClick={() => onFollow(!follow)}>
        Follow
      </Button>
      <Button variant="outline" size="sm" className={toggle(warningsOnly)} aria-pressed={warningsOnly} onClick={() => onWarningsOnly(!warningsOnly)}>
        Only warnings
      </Button>
      <Button variant="outline" size="sm" className="pointer-coarse:min-h-11" disabled={!text} onClick={copy}>
        {copied ? <CheckIcon className="size-4" /> : <CopyIcon className="size-4" />}
        {copied ? 'Copied' : 'Copy'}
      </Button>
    </div>
  );
}
