import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { PlayIcon, ScrollTextIcon, Trash2Icon } from 'lucide-react';
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  EmptyState,
  Input,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  StatusBadge,
  Textarea,
  toast,
} from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';
import { effectTone, enabledTone } from '@/components/access/access-shared';

/** Policies tab: no-code builder + live simulator + the flat policy list. */
export function PoliciesTab(): React.JSX.Element {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const policies = useQuery(trpc.policies.list.queryOptions());
  const rows = policies.data ?? [];

  const del = useMutation(
    trpc.policies.delete.mutationOptions({
      onSuccess: () => {
        toast.success('Policy deleted');
        void qc.invalidateQueries();
      },
      onError: (e) => toast.error(e.message),
    }),
  );

  return (
    <div className="grid gap-6">
      <div className="grid gap-6 lg:grid-cols-2">
        <PolicyBuilder />
        <PolicySimulator />
      </div>

      <Card className="card-pop border-0">
        <CardHeader>
          <CardTitle className="text-base">Policies</CardTitle>
          <CardDescription>
            Evaluated by priority. Defaults reproduce today&apos;s owner/admin/member roles.
          </CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          {rows.length === 0 ? (
            <div className="px-6 pb-6">
              <EmptyState
                icon={<ScrollTextIcon />}
                title="No policies yet"
                description="Defaults keep today's roles in force. Build a rule above to bend access to your team."
              />
            </div>
          ) : (
            <>
              <div className="grid grid-cols-[1.5fr_auto] gap-x-4 px-6 py-3 sm:grid-cols-[2fr_1fr_1fr_1fr_auto]">
                <span className="mono-label">Name</span>
                <span className="mono-label hidden sm:block">Effect</span>
                <span className="mono-label hidden sm:block">Priority</span>
                <span className="mono-label hidden sm:block">Status</span>
                <span className="mono-label text-right">Actions</span>
              </div>
              <div className="divide-border divide-y border-t">
                {rows.map((p) => (
                  <div
                    key={p.id}
                    className="hover:bg-accent/60 grid grid-cols-[1.5fr_auto] items-center gap-x-4 px-6 py-4 transition-colors sm:grid-cols-[2fr_1fr_1fr_1fr_auto]"
                  >
                    <div className="min-w-0">
                      <p className="flex items-center gap-2 truncate font-medium">
                        {p.name}
                        {p.isDefault && <Badge variant="muted">default</Badge>}
                      </p>
                      <p className="text-muted-foreground mono-label truncate sm:hidden">
                        {p.effect} · priority {p.priority}
                      </p>
                    </div>
                    <span className="hidden sm:block">
                      <StatusBadge tone={effectTone(p.effect)} label={p.effect} />
                    </span>
                    <span className="mono-data hidden sm:block">{p.priority}</span>
                    <span className="hidden sm:block">
                      <StatusBadge
                        tone={enabledTone(p.enabled)}
                        label={p.enabled ? 'enabled' : 'disabled'}
                      />
                    </span>
                    <div className="flex justify-end">
                      {!p.isDefault && (
                        <Button variant="ghost" size="sm" onClick={() => del.mutate({ id: p.id })}>
                          <Trash2Icon className="size-4" />
                        </Button>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function PolicyBuilder(): React.JSX.Element {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const actions = useQuery(trpc.policies.listActions.queryOptions());

  const [name, setName] = React.useState('');
  const [effect, setEffect] = React.useState<'permit' | 'forbid'>('permit');
  // No-code builder fields.
  const [action, setAction] = React.useState('service.restart');
  const [role, setRole] = React.useState('member');
  const [labelsText, setLabelsText] = React.useState('');
  const [relation, setRelation] = React.useState('');
  // Generated/editable JSON source.
  const [source, setSource] = React.useState(
    '{\n  "roles": ["member"],\n  "actions": ["service.restart"]\n}',
  );

  const validate = useQuery(trpc.policies.validate.queryOptions({ source }));

  const buildFromFields = (): void => {
    const doc: Record<string, unknown> = { actions: [action] };
    if (role) doc.roles = [role];
    if (relation) doc.relations = [relation];
    if (labelsText.trim()) {
      try {
        doc.resourceLabels = JSON.parse(labelsText);
      } catch {
        toast.error('Resource labels must be valid JSON');
        return;
      }
    }
    setSource(JSON.stringify(doc, null, 2));
  };

  const set = useMutation(
    trpc.policies.set.mutationOptions({
      onSuccess: () => {
        setName('');
        toast.success('Policy saved');
        void qc.invalidateQueries();
      },
      onError: (e) => toast.error(e.message),
    }),
  );

  return (
    <Card className="card-pop border-0">
      <CardHeader>
        <CardTitle className="text-base">New policy</CardTitle>
        <CardDescription>
          Build a rule, or edit the JSON directly. Defaults already reproduce owner/admin/member.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4 text-sm">
        <div className="flex flex-wrap items-end gap-3">
          <div className="grid min-w-[10rem] flex-1 gap-1.5">
            <Label className="mono-label">Name</Label>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="On-call may restart"
            />
          </div>
          <div className="grid gap-1.5">
            <Label className="mono-label">Effect</Label>
            <Select value={effect} onValueChange={(v) => setEffect(v as 'permit' | 'forbid')}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="permit">permit</SelectItem>
                <SelectItem value="forbid">forbid</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div className="grid gap-1.5">
            <Label className="mono-label">Action</Label>
            <Select value={action} onValueChange={setAction}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {(actions.data ?? []).map((a) => (
                  <SelectItem key={a} value={a}>
                    {a}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="grid gap-1.5">
            <Label className="mono-label">Role (optional)</Label>
            <Select value={role || 'none'} onValueChange={(v) => setRole(v === 'none' ? '' : v)}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">— any —</SelectItem>
                <SelectItem value="owner">owner</SelectItem>
                <SelectItem value="admin">admin</SelectItem>
                <SelectItem value="member">member</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="grid gap-1.5">
            <Label className="mono-label">Relation (optional)</Label>
            <Select
              value={relation || 'none'}
              onValueChange={(v) => setRelation(v === 'none' ? '' : v)}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">— none —</SelectItem>
                <SelectItem value="owner">owner</SelectItem>
                <SelectItem value="operator">operator</SelectItem>
                <SelectItem value="viewer">viewer</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="grid gap-1.5">
            <Label className="mono-label">Resource labels (JSON)</Label>
            <Input
              value={labelsText}
              placeholder='{"env":"staging"}'
              onChange={(e) => setLabelsText(e.target.value)}
            />
          </div>
        </div>
        <Button variant="outline" className="w-fit" onClick={buildFromFields}>
          Generate JSON ↓
        </Button>

        <div className="grid gap-1.5">
          <Label className="mono-label">
            Rule (JSON){' '}
            {validate.data &&
              (validate.data.valid ? (
                <span className="text-status-online">• valid</span>
              ) : (
                <span className="text-destructive">• {validate.data.error}</span>
              ))}
          </Label>
          <Textarea
            className="font-mono text-xs"
            rows={6}
            value={source}
            onChange={(e) => setSource(e.target.value)}
          />
        </div>
        <Button
          className="w-fit"
          disabled={set.isPending || !name || validate.data?.valid === false}
          onClick={() => set.mutate({ name, effect, source })}
        >
          Save policy
        </Button>
      </CardContent>
    </Card>
  );
}

function PolicySimulator(): React.JSX.Element {
  const trpc = useTRPC();
  const actions = useQuery(trpc.policies.listActions.queryOptions());
  const [action, setAction] = React.useState('service.restart');
  const [resourceType, setResourceType] = React.useState<'' | 'node' | 'service' | 'stack'>('');
  const [resourceId, setResourceId] = React.useState('');

  const sim = useQuery(
    trpc.policies.simulate.queryOptions(
      {
        action,
        ...(resourceType ? { resourceType } : {}),
        ...(resourceId ? { resourceId } : {}),
      },
      { enabled: false },
    ),
  );

  return (
    <Card className="card-pop border-0">
      <CardHeader>
        <CardTitle className="text-base">Simulator</CardTitle>
        <CardDescription>
          &ldquo;Can I do this?&rdquo; — runs the live decision path for your identity.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4 text-sm">
        <div className="grid gap-1.5">
          <Label className="mono-label">Action</Label>
          <Select value={action} onValueChange={setAction}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {(actions.data ?? []).map((a) => (
                <SelectItem key={a} value={a}>
                  {a}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div className="grid gap-1.5">
            <Label className="mono-label">Resource type</Label>
            <Select
              value={resourceType || 'none'}
              onValueChange={(v) =>
                setResourceType(v === 'none' ? '' : (v as 'node' | 'service' | 'stack'))
              }
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">— none —</SelectItem>
                <SelectItem value="node">node</SelectItem>
                <SelectItem value="service">service</SelectItem>
                <SelectItem value="stack">stack</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="grid gap-1.5">
            <Label className="mono-label">Resource id</Label>
            <Input value={resourceId} onChange={(e) => setResourceId(e.target.value)} />
          </div>
        </div>
        <Button className="w-fit" onClick={() => void sim.refetch()} disabled={sim.isFetching}>
          <PlayIcon className="size-4" /> Run
        </Button>
        {sim.data && (
          <div className="grid gap-1.5">
            <StatusBadge
              tone={sim.data.decision === 'permit' ? 'online' : 'offline'}
              label={sim.data.decision}
            />
            <p className="text-muted-foreground text-xs">
              {sim.data.reasons.join('; ')}
              {sim.data.policyId ? ` (policy ${sim.data.policyId})` : ''}
            </p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
