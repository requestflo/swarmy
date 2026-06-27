import * as React from 'react';
import { PlusIcon } from 'lucide-react';
import { Button, Input, Label } from '@swarmy/ui';
import { NodeRolePicker, type NodeRoleChoice } from './node-role-picker';

interface MintTokenFormProps {
  role: NodeRoleChoice;
  onRoleChange: (role: NodeRoleChoice) => void;
  label: string;
  onLabelChange: (value: string) => void;
  nodeLabels: string;
  onNodeLabelsChange: (value: string) => void;
  onSubmit: () => void;
  pending: boolean;
}

/** Pre-mint card: choose a role, tag the node, then mint the one coral CTA. */
export function MintTokenForm({
  role,
  onRoleChange,
  label,
  onLabelChange,
  nodeLabels,
  onNodeLabelsChange,
  onSubmit,
  pending,
}: MintTokenFormProps): React.JSX.Element {
  return (
    <div className="card-pop grid gap-5 rounded-2xl border-0 p-6 sm:p-8">
      <NodeRolePicker role={role} onChange={onRoleChange} />

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="grid gap-1.5">
          <Label htmlFor="node-name" className="mono-label">
            Token label (optional)
          </Label>
          <Input
            id="node-name"
            value={label}
            onChange={(e) => onLabelChange(e.target.value)}
            placeholder="prod-worker-1"
          />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="node-labels" className="mono-label">
            Node labels (optional)
          </Label>
          <Input
            id="node-labels"
            value={nodeLabels}
            onChange={(e) => onNodeLabelsChange(e.target.value)}
            placeholder="role=web,region=eu"
          />
        </div>
      </div>

      <div className="flex justify-end">
        <Button size="lg" onClick={onSubmit} disabled={pending}>
          <PlusIcon className="size-4" />
          {pending ? 'Minting…' : 'Get my one-liner'}
        </Button>
      </div>
    </div>
  );
}
