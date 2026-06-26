import * as React from 'react';
import { CheckIcon, CopyIcon } from 'lucide-react';
import { Button } from './button';
import { cn } from '../lib/utils';

export function CopyButton({
  value,
  className,
  label,
}: {
  value: string;
  className?: string;
  label?: string;
}) {
  const [copied, setCopied] = React.useState(false);
  return (
    <Button
      type="button"
      variant="outline"
      size={label ? 'sm' : 'icon'}
      className={cn(className)}
      onClick={() => {
        void navigator.clipboard.writeText(value);
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      }}
    >
      {copied ? <CheckIcon className="text-emerald-500" /> : <CopyIcon />}
      {label ? <span>{copied ? 'Copied' : label}</span> : null}
    </Button>
  );
}
