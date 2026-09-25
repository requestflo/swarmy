import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { ACTION_CATALOG } from '@swarmy/abac/model';
import { PlayIcon } from 'lucide-react';
import {
  Button,
  Input,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@swarmy/ui';
import { Section, StatusWord, Tech } from '@/components/calm';
import { useTRPC } from '@/integrations/trpc';

type ResType = 'service' | 'stack' | 'node';

/** "Who can do X?" — every member's decision for one action, plus the rule that decided it. */
export function PolicyWhoCan(): React.JSX.Element {
  const trpc = useTRPC();
  const [action, setAction] = React.useState('service.deploy');
  const [resourceType, setResourceType] = React.useState<ResType>('service');
  const [env, setEnv] = React.useState('production');
  const [resourceId, setResourceId] = React.useState('');

  const q = useQuery(
    trpc.policies.whoCan.queryOptions(
      {
        action,
        resourceType,
        ...(resourceId.trim() ? { resourceId: resourceId.trim() } : env !== 'any' ? { env } : {}),
      },
      { enabled: false },
    ),
  );
  const rows = q.data?.rows ?? [];
  const allowed = rows.filter((r) => r.decision === 'permit').length;

  return (
    <Section title="Try it" hint="who can…?">
      <p className="text-muted-foreground text-[13px]">Runs the live rules for everyone. Nothing is changed or recorded.</p>
      <div className="grid gap-4 text-sm">
        <div className="grid gap-3 sm:grid-cols-3 xl:grid-cols-1">
          <div className="grid gap-1.5">
            <Label>Do</Label>
            <Select value={action} onValueChange={setAction}>
              <SelectTrigger aria-label="Do">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {ACTION_CATALOG.map((a) => (
                  <SelectItem key={a.id} value={a.id}>
                    {a.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="grid gap-1.5">
            <Label>On</Label>
            <Select value={resourceType} onValueChange={(v) => setResourceType(v as ResType)}>
              <SelectTrigger aria-label="On">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="service">a service</SelectItem>
                <SelectItem value="stack">an app</SelectItem>
                <SelectItem value="node">a server</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="grid gap-1.5">
            <Label>In</Label>
            <Select value={env} onValueChange={setEnv} disabled={Boolean(resourceId.trim())}>
              <SelectTrigger aria-label="In">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="production">production</SelectItem>
                <SelectItem value="staging">staging</SelectItem>
                <SelectItem value="any">no environment</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>
        <div className="flex flex-wrap items-end gap-3">
          <div className="grid min-w-[12rem] flex-1 gap-1.5">
            <Label>Or a real one (name or id, optional)</Label>
            <Input aria-label="Or a real one" value={resourceId} placeholder="shop_web" onChange={(e) => setResourceId(e.target.value)} />
          </div>
          <Button variant="outline" className="pointer-coarse:min-h-11" onClick={() => void q.refetch()} disabled={q.isFetching}>
            <PlayIcon className="size-4" /> Check
          </Button>
        </div>
        {q.error && <p className="text-tone-bad text-xs">{q.error.message}</p>}
        {q.data && (
          <div className="grid gap-2">
            <p className="text-muted-foreground text-[13px] font-semibold">
              {allowed} of {rows.length} can
            </p>
            <div className="flex flex-col">
              {rows.map((r) => (
                <div key={r.memberId} className="border-border flex flex-wrap items-center gap-x-3 gap-y-1 border-b py-2.5 last:border-b-0">
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-medium">{r.name ?? r.email ?? r.userId}</p>
                    <p className="text-muted-foreground truncate text-xs">{r.role}{r.groups.length ? ` · ${r.groups.join(', ')}` : ''}</p>
                    <Tech>{r.reasons.join('; ')}</Tech>
                  </div>
                  <StatusWord tone={r.decision === 'permit' ? 'ok' : 'bad'} word={r.decision === 'permit' ? 'Can' : 'Can’t'} />
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </Section>
  );
}
