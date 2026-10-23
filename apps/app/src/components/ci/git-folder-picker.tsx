import * as React from 'react';
import { FolderIcon, FolderOpenIcon } from 'lucide-react';
import { cn, Input } from '@swarmy/ui';
import { Depth } from '@/components/calm';
import { TextSkeleton } from '@/components/states';
import { GitChip } from './git-chip';
import { GitComposeDraft } from './git-compose-draft';
import { defaultFolder, folderTree, isMonorepo } from './git-folder-tree';
import type { GitWizard } from './use-git-wizard';
import { useInspectSource } from './use-inspect-source';
import type { LinkedApp } from './use-linked-apps';

/**
 * "Folder in northwind/platform": the repo's folders that hold an app (or the
 * start of one), tagged by the files we found — read on a builder, nothing
 * cloned to the controller. Picking one sets the swarmy.yaml the app reads.
 */
export function GitFolderPicker({
  w,
  appAt,
}: {
  w: GitWizard;
  appAt: (cloneUrl: string, configPath: string) => LinkedApp | undefined;
}): React.JSX.Element {
  const found = useInspectSource(w.source);
  const rows = React.useMemo(() => folderTree(found.data?.tree ?? []), [found.data]);
  const cloneUrl = w.source?.cloneUrl ?? '';
  const { configPath, setConfigPath } = w;

  // Start on the likeliest folder once the tree arrives (never over a choice).
  React.useEffect(() => {
    if (configPath || rows.length === 0) return;
    const taken = rows.filter((r) => appAt(cloneUrl, r.configPath)).map((r) => r.configPath);
    const pick = defaultFolder(rows, taken);
    if (pick) setConfigPath(pick.configPath);
  }, [rows, configPath, setConfigPath, appAt, cloneUrl]);

  const current = configPath || 'swarmy.yaml';
  return (
    <section aria-label="Folder" className="calm-card flex min-w-0 flex-col gap-2 px-4 py-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className="calm-eyebrow truncate">Folder in {w.repoName ?? 'the repo'}</span>
        {found.data ? <GitChip className="ml-auto">{isMonorepo(rows) ? 'monorepo' : 'root'}</GitChip> : null}
      </div>
      {!w.source ? (
        <p className="text-muted-foreground text-sm">Pick a repo and a branch, and we look inside.</p>
      ) : found.isFetching || (!found.data && !found.isError) ? (
        <>
          <p className="text-muted-foreground flex items-center gap-2 text-sm">
            <span className="pulse-dot" /> Reading {w.source.ref} on one of your servers…
          </p>
          <TextSkeleton className="h-24 w-full rounded-xl" />
        </>
      ) : found.isError ? (
        <p className="text-muted-foreground text-sm">Couldn’t look inside yet ({found.error.message}). Switch to Controls to type the swarmy.yaml path.</p>
      ) : rows.length === 0 ? (
        <p className="text-sm">Nothing to build here yet — no Dockerfile, compose file or swarmy.yaml on {w.source.ref}.</p>
      ) : (
        <ul className="flex flex-col">
          {rows.map((r) => {
            const on = r.pickable && current === r.configPath;
            const app = r.pickable ? appAt(cloneUrl, r.configPath) : undefined;
            const Icon = on ? FolderOpenIcon : FolderIcon;
            return (
              <li key={r.dir || '/'}>
                <button
                  type="button"
                  disabled={!r.pickable}
                  aria-pressed={r.pickable ? on : undefined}
                  onClick={() => setConfigPath(r.configPath)}
                  style={{ paddingLeft: 8 + r.depth * 18 }}
                  className={cn(
                    'flex min-h-9 w-full items-center gap-2 rounded-lg pr-2 text-left text-[13px] outline-none focus-visible:ring-2 focus-visible:ring-ring/60 pointer-coarse:min-h-11',
                    r.pickable ? 'hover:bg-foreground/[0.03]' : 'text-muted-foreground cursor-default',
                    on && 'bg-accent font-semibold',
                  )}
                >
                  <Icon aria-hidden className={cn('size-4 shrink-0', on ? 'text-foreground' : 'text-muted-foreground')} />
                  <span className="min-w-0 truncate font-mono">{r.name}</span>
                  <span className="ml-auto flex flex-wrap justify-end gap-1">
                    {app ? <GitChip tone="mesh">{`app · ${app.name}`}</GitChip> : null}
                    {r.tags.map((t) => (
                      <GitChip key={t} tone={t === 'swarmy.yaml' ? 'mesh' : t === 'Dockerfile' ? 'ok' : 'idle'}>{t}</GitChip>
                    ))}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
      {found.data?.composeDraft && current === 'swarmy.yaml' ? <GitComposeDraft draft={found.data.composeDraft} /> : null}
      <Depth at="controls">
        <label className="text-muted-foreground mt-1 flex flex-col gap-1 text-xs">
          Path to swarmy.yaml
          <Input value={configPath} onChange={(e) => setConfigPath(e.target.value)} placeholder="swarmy.yaml" className="h-8 font-mono text-[12.5px]" />
        </label>
      </Depth>
    </section>
  );
}
