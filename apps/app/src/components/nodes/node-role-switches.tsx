import * as React from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { RouteIcon, ShieldIcon } from 'lucide-react';
import { Label, Switch, toast } from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';

interface NodeRoleSwitchesProps {
  nodeId: string;
  ingress: boolean;
  outlet: boolean;
}

/** Ingress-edge / egress-outlet role toggles — `swarmy.node.{ingress,outlet}` labels. */
export function NodeRoleSwitches({ nodeId, ingress, outlet }: NodeRoleSwitchesProps): React.JSX.Element {
  const trpc = useTRPC();
  const qc = useQueryClient();

  const setRole = useMutation(
    trpc.nodes.setRole.mutationOptions({
      onSuccess: () => void qc.invalidateQueries(),
      onError: (e) => toast.error(e.message),
    }),
  );

  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <RoleRow
        icon={<RouteIcon className="size-3.5" />}
        label="Ingress edge"
        hint="Placement target for public-facing routes."
        checked={ingress}
        disabled={setRole.isPending}
        onCheckedChange={(v) => setRole.mutate({ id: nodeId, ingress: v })}
      />
      <RoleRow
        icon={<ShieldIcon className="size-3.5" />}
        label="Egress outlet"
        hint="Placement target for outbound/DNS services."
        checked={outlet}
        disabled={setRole.isPending}
        onCheckedChange={(v) => setRole.mutate({ id: nodeId, outlet: v })}
      />
    </div>
  );
}

interface RoleRowProps {
  icon: React.ReactNode;
  label: string;
  hint: string;
  checked: boolean;
  disabled: boolean;
  onCheckedChange: (v: boolean) => void;
}

function RoleRow({ icon, label, hint, checked, disabled, onCheckedChange }: RoleRowProps): React.JSX.Element {
  return (
    <div className="bg-accent/40 flex items-center justify-between gap-3 rounded-xl px-4 py-3">
      <div className="min-w-0">
        <Label className="flex items-center gap-1.5 font-semibold">
          {icon} {label}
        </Label>
        <p className="text-muted-foreground mt-0.5 text-xs leading-snug">{hint}</p>
      </div>
      <Switch checked={checked} disabled={disabled} onCheckedChange={onCheckedChange} />
    </div>
  );
}
