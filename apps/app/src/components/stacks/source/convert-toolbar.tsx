import * as React from 'react';
import { DownloadIcon, FileCodeIcon } from 'lucide-react';
import type { ConfigIssue } from '@swarmy/app-config';
import { Button, CopyButton } from '@swarmy/ui';
import { download } from '@/components/studio/studio-export';
import { convertStatus } from './convert-model';
import { ToneChip } from './tone-chip';

/**
 * The generated file's top row: what it is, the parser's verdict, that it's
 * read-only here, and Copy / Download — the two ways it leaves swarmy.
 */
export function ConvertToolbar({ path, yaml, issues }: { path: string; yaml: string; issues: readonly ConfigIssue[] }): React.JSX.Element {
  const status = convertStatus(issues);
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <ToneChip tone="idle" className="font-mono">
          <FileCodeIcon aria-hidden className="size-3" />
          {path} · generated
        </ToneChip>
        <ToneChip tone={status.tone}>{status.text}</ToneChip>
        <ToneChip tone="info">read-only</ToneChip>
        <div className="ml-auto flex items-center gap-2">
          <CopyButton value={yaml} label="Copy" className="pointer-coarse:min-h-11" />
          <Button type="button" size="sm" variant="outline" className="pointer-coarse:min-h-11" onClick={() => download(path, yaml, 'application/yaml')}>
            <DownloadIcon aria-hidden className="size-4" /> Download
          </Button>
        </div>
      </div>
      <p className="text-muted-foreground text-xs">Read-only for now. Edit it in your repo once it’s there.</p>
    </div>
  );
}
