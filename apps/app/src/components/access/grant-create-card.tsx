import * as React from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Button,
  Collapsible,
  CollapsibleContent,
  Input,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  toast,
} from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';

interface GrantCreateCardProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/** Inline expanding card (no modal): principal + resource + relation. */
export function GrantCreateCard({ open, onOpenChange }: GrantCreateCardProps): React.JSX.Element {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const [principalType, setPrincipalType] = React.useState<'member' | 'team'>('member');
  const [principalId, setPrincipalId] = React.useState('');
  const [resourceType, setResourceType] = React.useState<'node' | 'service' | 'stack'>('service');
  const [resourceId, setResourceId] = React.useState('');
  const [relation, setRelation] = React.useState<'owner' | 'operator' | 'viewer'>('operator');

  const create = useMutation(
    trpc.members.createGrant.mutationOptions({
      onSuccess: () => {
        toast.success('Grant created');
        setPrincipalId('');
        setResourceId('');
        onOpenChange(false);
        void qc.invalidateQueries();
      },
      onError: (e) => toast.error(e.message),
    }),
  );

  return (
    <Collapsible open={open} onOpenChange={onOpenChange}>
      <CollapsibleContent>
        <div className="border-t px-6 py-5">
          <div className="grid gap-3 text-sm sm:grid-cols-2">
            <div className="grid gap-1.5">
              <Label className="mono-label">Principal type</Label>
              <Select value={principalType} onValueChange={(v) => setPrincipalType(v as 'member' | 'team')}>
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
            <div className="grid gap-1.5">
              <Label className="mono-label">Resource type</Label>
              <Select value={resourceType} onValueChange={(v) => setResourceType(v as typeof resourceType)}>
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
            <div className="grid gap-1.5 sm:col-span-2">
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
          </div>
          <div className="mt-3 flex justify-end gap-2">
            <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button
              size="sm"
              disabled={create.isPending || !principalId || !resourceId}
              onClick={() =>
                create.mutate({ principalType, principalId, resourceType, resourceId, relation })
              }
            >
              Create
            </Button>
          </div>
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}
