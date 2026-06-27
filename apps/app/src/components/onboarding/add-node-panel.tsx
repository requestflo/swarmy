import * as React from 'react';
import { Link } from '@tanstack/react-router';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { CrownIcon, KeyRoundIcon, PlusIcon, ServerIcon, TerminalIcon } from 'lucide-react';
import { Button, CopyButton, Input, Label, cn, toast } from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';
import { useAwaitNode } from './use-await-node';

export type NodeRoleChoice = 'auto' | 'manager' | 'worker';

function installOneLiner(token: string, labels: string, role: NodeRoleChoice): string {
  const origin = typeof window !== 'undefined' ? window.location.origin : '';
  const labelEnv = labels.trim() ? `SWARMY_NODE_LABELS=${labels.trim()} ` : '';
  // `auto` lets the controller decide (first node → manager, rest → worker).
  const roleEnv = role === 'auto' ? '' : `SWARMY_ROLE_HINT=${role} `;
  return `curl -fsSL ${origin}/install.sh | SWARMY_JOIN_TOKEN=${token} ${roleEnv}${labelEnv}sh`;
}

/**
 * Hot Signal "Add a node" guided experience: mint a token, copy the one-liner,
 * then watch the node connect live. Self-contained so it can drop into Settings
 * or a dedicated /nodes/new route.
 */
export function AddNodePanel(): React.JSX.Element {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const [token, setToken] = React.useState<string | null>(null);
  const [label, setLabel] = React.useState('');
  const [nodeLabels, setNodeLabels] = React.useState('');
  const [role, setRole] = React.useState<NodeRoleChoice>('auto');

  const arrived = useAwaitNode(token !== null);

  const generate = useMutation(
    trpc.nodes.generateJoinToken.mutationOptions({
      onSuccess: (res) => {
        setToken(res.token);
        void qc.invalidateQueries();
      },
      onError: (e) => toast.error(e.message),
    }),
  );

  return (
    <div className="grid gap-6">
      <OsPicker />

      {token === null ? (
        <div className="card-pop grid gap-4 rounded-2xl border-0 p-6">
          <RolePicker role={role} onChange={setRole} />
          <div className="flex flex-wrap items-end gap-3">
            <div className="grid min-w-[12rem] flex-1 gap-1.5">
              <Label htmlFor="node-name" className="mono-label">
                Token label (optional)
              </Label>
              <Input
                id="node-name"
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                placeholder="prod-worker-1"
              />
            </div>
            <div className="grid min-w-[12rem] flex-1 gap-1.5">
              <Label htmlFor="node-labels" className="mono-label">
                Node labels (optional)
              </Label>
              <Input
                id="node-labels"
                value={nodeLabels}
                onChange={(e) => setNodeLabels(e.target.value)}
                placeholder="role=web,region=eu"
              />
            </div>
            <Button
              onClick={() => generate.mutate({ label: label || undefined })}
              disabled={generate.isPending}
            >
              <PlusIcon className="size-4" /> Get my one-liner
            </Button>
          </div>
        </div>
      ) : (
        <CommandStep token={token} labels={nodeLabels} role={role} arrived={arrived} />
      )}
    </div>
  );
}

function OsPicker(): React.JSX.Element {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="mono-label text-muted-foreground mr-1">Target OS</span>
      <span className="bg-ink text-ink-foreground inline-flex items-center gap-2 rounded-full px-3 py-1 text-xs font-bold">
        <span className="pulse-dot bg-status-online" /> Linux
      </span>
      <span className="text-muted-foreground inline-flex items-center gap-2 rounded-full border border-dashed px-3 py-1 text-xs font-medium">
        macOS / Windows · soon
      </span>
    </div>
  );
}

const ROLE_OPTIONS: { value: NodeRoleChoice; title: string; hint: string; icon: React.ReactNode }[] = [
  { value: 'auto', title: 'Automatic', hint: 'First node becomes manager; the rest join as workers.', icon: <ServerIcon className="size-4" /> },
  { value: 'manager', title: 'Manager', hint: 'Runs the swarm control plane. Keep an odd number.', icon: <CrownIcon className="size-4" /> },
  { value: 'worker', title: 'Worker', hint: 'Runs workloads; joins an existing manager.', icon: <ServerIcon className="size-4" /> },
];

function RolePicker({
  role,
  onChange,
}: {
  role: NodeRoleChoice;
  onChange: (r: NodeRoleChoice) => void;
}): React.JSX.Element {
  return (
    <fieldset className="grid gap-2">
      <Label className="mono-label">Node role</Label>
      <div className="grid gap-2 sm:grid-cols-3" role="radiogroup" aria-label="Node role">
        {ROLE_OPTIONS.map((opt) => (
          <button
            key={opt.value}
            type="button"
            role="radio"
            aria-checked={role === opt.value}
            onClick={() => onChange(opt.value)}
            className={cn(
              'flex flex-col gap-1 rounded-xl border p-3 text-left transition-colors',
              role === opt.value
                ? 'border-primary bg-primary/5'
                : 'border-border hover:border-primary/40',
            )}
          >
            <span className="flex items-center gap-2 text-sm font-bold">
              {opt.icon} {opt.title}
            </span>
            <span className="text-muted-foreground text-xs">{opt.hint}</span>
          </button>
        ))}
      </div>
    </fieldset>
  );
}

function CommandStep({
  token,
  labels,
  role,
  arrived,
}: {
  token: string;
  labels: string;
  role: NodeRoleChoice;
  arrived: { id: string; name: string } | null;
}): React.JSX.Element {
  const oneLiner = installOneLiner(token, labels, role);
  return (
    <div className="ink-block grid gap-5 rounded-2xl border-0 p-6">
      <div className="flex items-start gap-3">
        <KeyRoundIcon className="text-primary mt-0.5 size-5 shrink-0" />
        <div>
          <p className="font-bold">Paste this on any fresh Linux box.</p>
          <p className="text-ink-foreground/60 text-sm">
            Copy it now — the token won't be shown again. It installs Docker if needed, starts the agent,
            and the node phones home.
          </p>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <code className="bg-ink-foreground/10 mono-data flex-1 overflow-x-auto rounded-lg px-3 py-2.5 text-xs">
          <TerminalIcon className="text-primary mr-2 inline size-3.5" />
          {oneLiner}
        </code>
        <CopyButton value={oneLiner} label="Copy" />
      </div>

      <WaitingState arrived={arrived} />
    </div>
  );
}

function WaitingState({ arrived }: { arrived: { id: string; name: string } | null }): React.JSX.Element {
  if (arrived) {
    return (
      <Link
        to="/nodes/$nodeId"
        params={{ nodeId: arrived.id }}
        className="bg-status-online/12 hover:bg-status-online/20 flex items-center gap-3 rounded-xl px-4 py-3 transition-colors"
      >
        <span className="text-status-online text-lg font-bold">✓</span>
        <span className="text-sm font-medium">
          <span className="mono-data">{arrived.name}</span> is online. Open node →
        </span>
      </Link>
    );
  }
  return (
    <div className="bg-ink-foreground/5 flex items-center gap-3 rounded-xl px-4 py-3">
      <span className={cn('pulse-dot bg-status-progress')} />
      <span className="text-ink-foreground/70 text-sm">Waiting for your node to connect…</span>
    </div>
  );
}
