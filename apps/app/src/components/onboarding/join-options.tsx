import * as React from 'react';
import { RefreshCwIcon } from 'lucide-react';
import { Button, Input, Label } from '@swarmy/ui';
import { Section, Tech } from '@/components/calm';
import { NodeRolePicker, type NodeRoleChoice } from './node-role-picker';

/**
 * Controls depth for Add a server: its role (Automatic by default), labels it
 * joins with, and a fresh labelled link. Role and labels change the command in
 * place; only "Make a new link" mints another token.
 */
export function JoinOptions({
  role,
  onRoleChange,
  labels,
  onLabelsChange,
  onRemint,
  pending,
}: {
  role: NodeRoleChoice;
  onRoleChange: (r: NodeRoleChoice) => void;
  labels: string;
  onLabelsChange: (v: string) => void;
  onRemint: (label: string) => void;
  pending: boolean;
}): React.JSX.Element {
  const [label, setLabel] = React.useState('');
  return (
    <Section title="How it joins" hint="the command above follows these">
      <NodeRolePicker role={role} onChange={onRoleChange} />
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="grid gap-1.5">
          <Label htmlFor="join-labels">Labels it joins with</Label>
          <Input
            id="join-labels"
            className="font-mono"
            value={labels}
            onChange={(e) => onLabelsChange(e.target.value)}
            placeholder="zone=eu-west,disk=ssd"
          />
          <Tech>SWARMY_NODE_LABELS · comma-separated key=value</Tech>
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="join-token-label">Name this link</Label>
          <div className="flex gap-2">
            <Input
              id="join-token-label"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="london-3"
            />
            <Button type="button" variant="outline" disabled={pending} onClick={() => onRemint(label)} className="pointer-coarse:min-h-11 shrink-0">
              <RefreshCwIcon className="size-4" /> {pending ? 'Making…' : 'New link'}
            </Button>
          </div>
          <Tech>nodes.generateJoinToken · single use · 1 h · listed in Settings → Join tokens</Tech>
        </div>
      </div>
    </Section>
  );
}
