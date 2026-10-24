import * as React from 'react';
import { Button, toast } from '@swarmy/ui';
import { Depth } from '@/components/calm';
import { ErrorState, TextSkeleton } from '@/components/states';
import { download } from '@/components/studio/studio-export';
import { GitChip } from './git-chip';
import { GitScanBuild } from './git-scan-build';
import { GitScanDetections } from './git-scan-detections';
import { GitScanGraph } from './git-scan-graph';
import { draftSummary, scannedLabel } from './git-scan-model';
import type { AppScan } from './git-scan-types';
import { GitScanYaml } from './git-scan-yaml';
import { useScanDraft } from './use-scan-draft';

interface GitScanBoardProps {
  found: AppScan;
  /** owner/name, for the eyebrow. */
  repo: string;
  branch: string;
  /** Where the app reads its swarmy.yaml — where this one should be committed. */
  configPath: string;
}

/**
 * "Here's what we found" (board 24): after Link & scan, a folder with no
 * swarmy.yaml shows what its code needs — each with the line that says so —
 * the swarmy.yaml that follows from what's ticked (checked by the
 * controller's parser), and the app it would create. Copy or download it,
 * commit it, push: that push deploys it.
 */
export function GitScanBoard({ found, repo, branch, configPath }: GitScanBoardProps): React.JSX.Element {
  const s = useScanDraft(found);
  const draft = s.draft;
  const copy = (): void => {
    if (!draft) return;
    void navigator.clipboard.writeText(draft.yaml).then(
      () => toast.success(`Copied — commit it as ${configPath}.`),
      () => toast.error('Couldn’t reach the clipboard — use Download instead.'),
    );
  };

  return (
    <section aria-label="Here’s what we found" className="@container flex flex-col gap-5 border-t pt-5">
      <header className="flex flex-col gap-1">
        <span className="calm-eyebrow truncate">
          {repo} · {found.dir || 'repo root'}
        </span>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <h2 className="font-display text-[1.35rem] leading-tight font-bold tracking-[-0.02em]">Here’s what we found</h2>
          <GitChip tone="ok" mono>
            {scannedLabel(found.files, found.ms)}
          </GitChip>
          {draft ? <span className="text-muted-foreground font-mono text-[11.5px] @3xl:ml-auto">{draftSummary(draft.graph, draft.yaml)}</span> : null}
        </div>
        <p className="text-muted-foreground text-[13.5px] leading-relaxed">
          Untick anything you don’t want — the swarmy.yaml follows. Nothing runs until it’s committed.
        </p>
      </header>

      <div className="grid gap-5 @3xl:grid-cols-2">
        <GitScanDetections dir={found.dir} detections={found.detections} selected={s.selected} onToggle={s.toggle} />
        {draft || !s.isError ? <GitScanGraph graph={draft?.graph ?? null} stale={s.isFetching} /> : null}
      </div>

      {draft ? (
        <GitScanYaml path={configPath} draft={draft} stale={s.isFetching} />
      ) : s.isError ? (
        <ErrorState title="Couldn’t write the swarmy.yaml." error={s.error} retry={s.refetch} />
      ) : (
        <TextSkeleton className="h-64 w-full rounded-xl" />
      )}

      <Depth at="controls">
        <GitScanBuild dir={found.dir} facts={found.build} form={s.form} onChange={s.setField} />
      </Depth>

      <div className="flex flex-wrap items-center gap-3 border-t pt-4">
        <Button size="lg" onClick={copy} disabled={!draft} className="pointer-coarse:min-h-11">
          Copy swarmy.yaml
        </Button>
        <Button
          variant="outline"
          disabled={!draft}
          onClick={() => draft && download('swarmy.yaml', draft.yaml, 'application/yaml')}
          className="pointer-coarse:min-h-11"
        >
          Download
        </Button>
        <p className="text-muted-foreground min-w-0 text-[12.5px] leading-relaxed">
          Commit it as <span className="font-mono">{configPath}</span> and push to <span className="font-mono">{branch}</span> — that
          push deploys it.
        </p>
      </div>
    </section>
  );
}
