import * as React from 'react';
import { FileCode2Icon } from 'lucide-react';
import { GitBuildDetected, type BuildDetected } from './git-build-detected';

const where = (dir: string): string => dir || 'the repo root';

/** The headline for the picked folder, from what the read found there. */
export function foundWords(
  dir: string,
  files: string[],
  hasDraft: boolean,
): { head: string; sub: string } {
  const has = (f: string): boolean => files.some((p) => p === (dir ? `${dir}/${f}` : f));
  if (has('swarmy.yaml') || has('swarmy.yml'))
    return { head: 'swarmy.yaml found', sub: `${where(dir)} describes its own app — swarmy builds and runs what it says.` };
  if (has('Dockerfile'))
    return { head: 'A Dockerfile', sub: `No swarmy.yaml in ${where(dir)} yet. swarmy builds the Dockerfile as-is; a swarmy.yaml adds the rest.` };
  if (hasDraft && !dir) return { head: 'A compose file', sub: 'We turned it into a swarmy.yaml for you to commit.' };
  return { head: 'No swarmy.yaml here yet', sub: `swarmy builds ${where(dir)} without a Dockerfile when it recognises the stack.` };
}

/**
 * The files the read found in the picked folder, and — for the repo root,
 * where `inspectSource` runs build detection — how swarmy will build it
 * (framework, runtime, port).
 */
export function GitFoundItems({
  dir,
  files,
  detected,
}: {
  dir: string;
  files: string[];
  detected: BuildDetected | null;
}): React.JSX.Element {
  const here = files.filter((p) => (dir ? p.startsWith(`${dir}/`) && !p.slice(dir.length + 1).includes('/') : !p.includes('/')));
  return (
    <div className="flex flex-col gap-2.5">
      {here.length > 0 ? (
        <ul className="flex flex-col gap-1">
          {here.map((p) => (
            <li key={p} className="flex items-center gap-2 text-[13px]">
              <FileCode2Icon aria-hidden className="text-muted-foreground size-3.5 shrink-0" />
              <span className="min-w-0 truncate font-mono text-[12.5px]">{p}</span>
            </li>
          ))}
        </ul>
      ) : null}
      {detected && !dir ? <GitBuildDetected detected={detected} showStarter={false} /> : null}
    </div>
  );
}
