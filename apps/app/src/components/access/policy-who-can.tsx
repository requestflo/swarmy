import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { ACTION_CATALOG } from '@swarmy/abac/model';
import { PlayIcon } from 'lucide-react';
import {
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Input,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  StatusBadge,
} from '@swarmy/ui';
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
    <Card className="card-pop border-0">
      <CardHeader>
        <CardTitle className="text-base">Who can…?</CardTitle>
        <CardDescription>Runs the live rules for every member. Nothing is changed or recorded.</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4 text-sm">
        <div className="grid gap-3 sm:grid-cols-3">
          <div className="grid gap-1.5">
            <Label className="mono-label">Do</Label>
            <Select value={action} onValueChange={setAction}>
              <SelectTrigger>
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
            <Label className="mono-label">On</Label>
            <Select value={resourceType} onValueChange={(v) => setResourceType(v as ResType)}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="service">an app</SelectItem>
                <SelectItem value="stack">a stack</SelectItem>
                <SelectItem value="node">a node</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="grid gap-1.5">
            <Label className="mono-label">In</Label>
            <Select value={env} onValueChange={setEnv} disabled={Boolean(resourceId.trim())}>
              <SelectTrigger>
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
            <Label className="mono-label">Or a real one (id or name, optional)</Label>
            <Input value={resourceId} placeholder="shop_web" onChange={(e) => setResourceId(e.target.value)} />
          </div>
          <Button onClick={() => void q.refetch()} disabled={q.isFetching}>
            <PlayIcon className="size-4" /> Check
          </Button>
        </div>
        {q.error && <p className="text-destructive text-xs">{q.error.message}</p>}
        {q.data && (
          <div className="grid gap-2">
            <p className="mono-label text-muted-foreground">
              {allowed} of {rows.length} can
            </p>
            <div className="divide-border divide-y rounded-xl border">
              {rows.map((r) => (
                <div key={r.memberId} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-3">
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-medium">{r.name ?? r.email ?? r.userId}</p>
                    <p className="text-muted-foreground truncate text-xs">
                      {r.role}
                      {r.groups.length ? ` · ${r.groups.join(', ')}` : ''} · {r.reasons.join('; ')}
                    </p>
                  </div>
                  <StatusBadge tone={r.decision === 'permit' ? 'online' : 'offline'} label={r.decision === 'permit' ? 'can' : 'cannot'} />
                </div>
              ))}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
