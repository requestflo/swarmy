import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Trash2Icon, UsersIcon } from 'lucide-react';
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
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
import { type GrantEntry, type MemberEntry } from '@/components/access/access-shared';

/** Members tab: ABAC attribute bags + ReBAC resource grants. */
export function MembersTab(): React.JSX.Element {
  const trpc = useTRPC();
  const members = useQuery(trpc.members.list.queryOptions());
  const grants = useQuery(trpc.members.listGrants.queryOptions());
  const memberRows = members.data ?? [];
  const grantRows = grants.data ?? [];

  return (
    <div className="grid gap-6">
      <Card className="card-pop border-0">
        <CardHeader>
          <CardTitle className="text-base">Member attributes</CardTitle>
          <CardDescription>
            Attributes feed ABAC policies (e.g. <code>team</code>, <code>onCall</code>). Edit the
            JSON bag per member.
          </CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          {memberRows.length === 0 ? (
            <div className="px-6 pb-6">
              <EmptyState
                icon={<UsersIcon />}
                title="No members yet"
                description="Invite teammates from your org settings, then tag them with attributes here."
              />
            </div>
          ) : (
            <>
              <div className="grid grid-cols-[1.5fr_auto] gap-x-4 px-6 py-3 sm:grid-cols-[2fr_1fr_2fr_auto]">
                <span className="mono-label">Member</span>
                <span className="mono-label hidden sm:block">Role</span>
                <span className="mono-label hidden sm:block">Attributes</span>
                <span className="mono-label text-right">Edit</span>
              </div>
              <div className="divide-border divide-y border-t">
                {memberRows.map((m) => (
                  <div
                    key={m.id}
                    className="hover:bg-accent/60 grid grid-cols-[1.5fr_auto] items-center gap-x-4 px-6 py-4 transition-colors sm:grid-cols-[2fr_1fr_2fr_auto]"
                  >
                    <div className="min-w-0">
                      <p className="truncate font-medium">
                        {m.user.email ?? m.user.name ?? m.id}
                      </p>
                      <p className="text-muted-foreground mono-label truncate sm:hidden">
                        {m.role}
                      </p>
                    </div>
                    <span className="hidden sm:block">
                      <Badge variant="muted">{m.role}</Badge>
                    </span>
                    <span className="mono-data hidden truncate text-xs sm:block">
                      {Object.keys(m.attributes).length ? JSON.stringify(m.attributes) : '—'}
                    </span>
                    <div className="flex justify-end">
                      <AttributesEditor member={m as MemberEntry} />
                    </div>
                  </div>
                ))}
              </div>
            </>
          )}
        </CardContent>
      </Card>

      <Card className="card-pop border-0">
        <CardHeader className="flex flex-row items-center justify-between space-y-0">
          <div className="min-w-0">
            <CardTitle className="text-base">Resource grants (ReBAC)</CardTitle>
            <CardDescription>
              Grant a member or team an owner/operator/viewer relation on a specific resource.
            </CardDescription>
          </div>
          <GrantEditor />
        </CardHeader>
        <CardContent className="p-0">
          {grantRows.length === 0 ? (
            <div className="px-6 pb-6">
              <EmptyState
                icon={<UsersIcon />}
                title="No grants yet"
                description="Access falls back to roles + policies. Add a grant to give someone a relation on one resource."
                action={<GrantEditor />}
              />
            </div>
          ) : (
            <>
              <div className="grid grid-cols-[1.5fr_auto] gap-x-4 px-6 py-3 sm:grid-cols-[2fr_1fr_2fr_auto]">
                <span className="mono-label">Principal</span>
                <span className="mono-label hidden sm:block">Relation</span>
                <span className="mono-label hidden sm:block">Resource</span>
                <span className="mono-label text-right">Remove</span>
              </div>
              <div className="divide-border divide-y border-t">
                {grantRows.map((g) => (
                  <GrantRow key={g.id} grant={g} />
                ))}
              </div>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function AttributesEditor({ member }: { member: MemberEntry }): React.JSX.Element {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const [open, setOpen] = React.useState(false);
  const [text, setText] = React.useState(JSON.stringify(member.attributes, null, 2));

  const save = useMutation(
    trpc.members.setAttributes.mutationOptions({
      onSuccess: () => {
        toast.success('Attributes saved');
        setOpen(false);
        void qc.invalidateQueries();
      },
      onError: (e) => toast.error(e.message),
    }),
  );

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="ghost" size="sm">
          Edit
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Attributes — {member.user.email ?? member.id}</DialogTitle>
          <DialogDescription>
            JSON object. e.g. {`{ "team": "payments", "onCall": true }`}
          </DialogDescription>
        </DialogHeader>
        <Textarea
          className="font-mono text-xs"
          rows={8}
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
        <Button
          disabled={save.isPending}
          onClick={() => {
            let parsed: Record<string, unknown>;
            try {
              parsed = JSON.parse(text);
            } catch {
              toast.error('Attributes must be valid JSON');
              return;
            }
            save.mutate({ memberId: member.id, attributes: parsed });
          }}
        >
          Save
        </Button>
      </DialogContent>
    </Dialog>
  );
}

function GrantRow({ grant }: { grant: GrantEntry }): React.JSX.Element {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const del = useMutation(
    trpc.members.deleteGrant.mutationOptions({
      onSuccess: () => {
        toast.success('Grant removed');
        void qc.invalidateQueries();
      },
      onError: (e) => toast.error(e.message),
    }),
  );

  return (
    <div className="hover:bg-accent/60 grid grid-cols-[1.5fr_auto] items-center gap-x-4 px-6 py-4 transition-colors sm:grid-cols-[2fr_1fr_2fr_auto]">
      <div className="min-w-0">
        <p className="mono-data truncate text-xs">
          {grant.principalType}:{grant.principalId}
        </p>
        <p className="text-muted-foreground mono-label truncate sm:hidden">
          {grant.relation} · {grant.resourceType}:{grant.resourceId}
        </p>
      </div>
      <span className="hidden sm:block">
        <StatusBadge tone="online" label={grant.relation} />
      </span>
      <span className="mono-data hidden truncate text-xs sm:block">
        {grant.resourceType}:{grant.resourceId}
      </span>
      <div className="flex justify-end">
        <Button variant="ghost" size="sm" onClick={() => del.mutate({ id: grant.id })}>
          <Trash2Icon className="size-4" />
        </Button>
      </div>
    </div>
  );
}

function GrantEditor(): React.JSX.Element {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const [open, setOpen] = React.useState(false);
  const [principalType, setPrincipalType] = React.useState<'member' | 'team'>('member');
  const [principalId, setPrincipalId] = React.useState('');
  const [resourceType, setResourceType] = React.useState<'node' | 'service' | 'stack'>('service');
  const [resourceId, setResourceId] = React.useState('');
  const [relation, setRelation] = React.useState<'owner' | 'operator' | 'viewer'>('operator');

  const create = useMutation(
    trpc.members.createGrant.mutationOptions({
      onSuccess: () => {
        toast.success('Grant created');
        setOpen(false);
        setPrincipalId('');
        setResourceId('');
        void qc.invalidateQueries();
      },
      onError: (e) => toast.error(e.message),
    }),
  );

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm">New grant</Button>
      </DialogTrigger>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>New resource grant</DialogTitle>
        </DialogHeader>
        <div className="grid gap-3 text-sm">
          <div className="grid grid-cols-2 gap-3">
            <div className="grid gap-1.5">
              <Label className="mono-label">Principal type</Label>
              <Select
                value={principalType}
                onValueChange={(v) => setPrincipalType(v as 'member' | 'team')}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="member">member</SelectItem>
                  <SelectItem value="team">team</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-1.5">
              <Label className="mono-label">Principal id</Label>
              <Input value={principalId} onChange={(e) => setPrincipalId(e.target.value)} />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="grid gap-1.5">
              <Label className="mono-label">Resource type</Label>
              <Select
                value={resourceType}
                onValueChange={(v) => setResourceType(v as typeof resourceType)}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
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
          <div className="grid gap-1.5">
            <Label className="mono-label">Relation</Label>
            <Select value={relation} onValueChange={(v) => setRelation(v as typeof relation)}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="owner">owner</SelectItem>
                <SelectItem value="operator">operator</SelectItem>
                <SelectItem value="viewer">viewer</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <Button
            disabled={create.isPending || !principalId || !resourceId}
            onClick={() =>
              create.mutate({ principalType, principalId, resourceType, resourceId, relation })
            }
          >
            Create
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
