import * as React from 'react';
import { PlusIcon } from 'lucide-react';
import { ruleKey, type AppPathRule } from '@swarmy/core';
import { Button, Input, Switch, cn } from '@swarmy/ui';
import { GroupPicker } from './group-picker';
import { personName } from './simulate';
import type { AppAccessViewData } from './types';

interface Props {
  view: AppAccessViewData;
  /** Paths already ruled on this address (each path takes one rule). */
  taken: string[];
  pending: boolean;
  onAdd: (rule: AppPathRule) => void;
}

const EMPTY = { path: '', everyone: false, staff: true, groups: [] as string[], people: [] as string[] };

/** One new path rule: the path, then who may enter under it. */
export function PathRuleForm({ view, taken, pending, onAdd }: Props): React.JSX.Element {
  const [d, setD] = React.useState(EMPTY);
  const key = d.path.trim() ? ruleKey(d.path.trim().startsWith('/') ? d.path.trim() : `/${d.path.trim()}`) : null;
  const problem = !d.path.trim() ? null : key === null ? 'Use a plain path like /admin, with no ?, #, %, .. or //.' : taken.includes(key) ? 'That path already has a rule.' : null;
  const add = (): void => {
    if (key === null || problem) return;
    onAdd({
      path: key === '/' ? '/' : `${key}/*`,
      ...(d.everyone ? { everyone: true } : {}),
      ...(!d.everyone && d.staff ? { roles: ['owner', 'admin'] } : {}),
      ...(!d.everyone && d.groups.length ? { groups: d.groups } : {}),
      ...(!d.everyone && d.people.length ? { people: d.people } : {}),
    });
    setD(EMPTY);
  };
  const toggle = (id: string): void => setD({ ...d, people: d.people.includes(id) ? d.people.filter((x) => x !== id) : [...d.people, id] });

  return (
    <div className="space-y-4 border-t px-5 py-4">
      <label className="block space-y-1.5">
        <span className="font-semibold">Path</span>
        <Input className="max-w-xs font-mono" value={d.path} placeholder="/admin" onChange={(e) => setD({ ...d, path: e.target.value })} aria-invalid={Boolean(problem)} />
        <span className={cn('block text-sm', problem ? 'text-tone-bad' : 'text-muted-foreground')}>
          {problem ?? 'This path and everything under it, in any letter case.'}
        </span>
      </label>
      <label className="flex items-center justify-between gap-4">
        <span className="font-semibold">Everyone the app lets in</span>
        <Switch checked={d.everyone} onCheckedChange={(v) => setD({ ...d, everyone: v })} />
      </label>
      {!d.everyone ? (
        <>
          <label className="flex items-center justify-between gap-4">
            <span>
              <span className="font-semibold">Owners and admins</span>
              <span className="text-muted-foreground block text-sm">Off means only the groups and people below.</span>
            </span>
            <Switch checked={d.staff} onCheckedChange={(v) => setD({ ...d, staff: v })} />
          </label>
          <GroupPicker known={view.knownGroups} value={d.groups} onChange={(groups) => setD({ ...d, groups })} />
          <div className="space-y-2" role="group" aria-label="People">
            <span className="font-semibold">People</span>
            <div className="flex flex-wrap gap-1.5">
              {view.people.map((p) => (
                <button
                  key={p.memberId}
                  type="button"
                  aria-pressed={d.people.includes(p.memberId)}
                  onClick={() => toggle(p.memberId)}
                  className={cn('pointer-coarse:min-h-11 rounded-full border px-3 py-1 text-sm', d.people.includes(p.memberId) ? 'bg-accent font-semibold' : 'text-muted-foreground')}
                >
                  {personName(p)}
                </button>
              ))}
            </div>
          </div>
        </>
      ) : null}
      <div className="flex justify-end">
        <Button variant="outline" disabled={pending || key === null || Boolean(problem)} onClick={add}>
          <PlusIcon className="size-4" /> Add rule
        </Button>
      </div>
    </div>
  );
}
