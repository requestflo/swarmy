import * as React from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { SquareTerminalIcon, TerminalIcon } from 'lucide-react';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  toast,
} from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';
import { RoleRow } from './node-role-switches';

interface NodeAccessSwitchesProps {
  nodeId: string;
  name: string;
  /** Container exec toggle (`swarmy.node.exec` ≠ 'false'; default on). */
  exec: boolean;
  /** The agent's local SWARMY_ALLOW_EXEC override, if any (wins over the switch). */
  execOverride: 'allow' | 'deny' | null;
  /** Host shell toggle (`swarmy.node.shell=true`; default off). */
  shell: boolean;
  /** The agent's local SWARMY_ALLOW_NODE_SHELL override, if any (`deny` vetoes). */
  shellOverride: 'allow' | 'deny' | null;
}

function execHint(override: 'allow' | 'deny' | null): string {
  if (override === 'deny') return 'Blocked on the box: SWARMY_ALLOW_EXEC=false in its agent.env overrides this switch.';
  if (override === 'allow') return 'Forced on by SWARMY_ALLOW_EXEC=true on the box; the switch only sets the label.';
  return 'Shells into this node’s containers — still gated by access policy, audited and recorded.';
}

function shellHint(override: 'allow' | 'deny' | null): string {
  if (override === 'deny') return 'Blocked on the box: SWARMY_ALLOW_NODE_SHELL=false in its agent.env vetoes this switch.';
  return 'Root shell on the host itself. Admins only; approval-gated, always recorded.';
}

/**
 * Terminal capabilities for one node — the `swarmy.node.exec` / `swarmy.node.shell`
 * labels, set through the admin-only, audited `nodes.setRole`. Turning the host
 * shell ON is confirmed first: it grants root on the machine.
 */
export function NodeAccessSwitches({
  nodeId,
  name,
  exec,
  execOverride,
  shell,
  shellOverride,
}: NodeAccessSwitchesProps): React.JSX.Element {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const [confirmShell, setConfirmShell] = React.useState(false);

  const setRole = useMutation(
    trpc.nodes.setRole.mutationOptions({
      onSuccess: () => void qc.invalidateQueries(),
      onError: (e) => toast.error(e.message),
    }),
  );

  return (
    <>
      <div className="grid gap-3 sm:grid-cols-2">
        <RoleRow
          icon={<SquareTerminalIcon className="size-3.5" />}
          label="Container exec"
          hint={execHint(execOverride)}
          checked={execOverride === 'deny' ? false : execOverride === 'allow' ? true : exec}
          disabled={setRole.isPending}
          onCheckedChange={(v) => setRole.mutate({ id: nodeId, exec: v })}
        />
        <RoleRow
          icon={<TerminalIcon className="size-3.5" />}
          label="Host shell"
          hint={shellHint(shellOverride)}
          checked={shell && shellOverride !== 'deny'}
          disabled={setRole.isPending || shellOverride === 'deny'}
          onCheckedChange={(v) => (v ? setConfirmShell(true) : setRole.mutate({ id: nodeId, shell: false }))}
        />
      </div>

      <AlertDialog open={confirmShell} onOpenChange={setConfirmShell}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Allow a root shell on {name}?</AlertDialogTitle>
            <AlertDialogDescription>
              A host shell runs as root on the machine itself — outside every container, with full
              control of Docker and the box. Anyone your terminal policy allows (and, by default,
              an approver signs off on) can use it. Every session is recorded and this change is
              audited.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep it off</AlertDialogCancel>
            <AlertDialogAction onClick={() => setRole.mutate({ id: nodeId, shell: true })}>
              Allow host shell
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
