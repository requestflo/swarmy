import * as React from 'react';
import { useMutation } from '@tanstack/react-query';
import type { NodeSummary } from '@swarmy/core';
import { Badge, Button, Input, toast } from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';

interface NodeRegionRowProps {
  node: NodeSummary;
  onChange: () => void;
}

/** One node: region editor + public IP display with the override escape hatch. */
export function NodeRegionRow({ node, onChange }: NodeRegionRowProps): React.JSX.Element {
  const trpc = useTRPC();
  const [region, setRegion] = React.useState(node.region ?? '');
  const [ip, setIp] = React.useState('');
  const [editIp, setEditIp] = React.useState(false);

  const setNodeRegion = useMutation(
    trpc.geodns.setNodeRegion.mutationOptions({
      onSuccess: () => {
        toast.success('Region assigned');
        onChange();
      },
      onError: (e) => toast.error(e.message),
    }),
  );
  const setPublicIp = useMutation(
    trpc.nodes.setPublicIpOverride.mutationOptions({
      onSuccess: () => {
        toast.success('Public IP updated');
        setEditIp(false);
        setIp('');
        onChange();
      },
      onError: (e) => toast.error(e.message),
    }),
  );

  return (
    <div className="hover:bg-accent/40 flex flex-wrap items-center gap-3 px-6 py-4 transition-colors">
      <div className="min-w-0 flex-1">
        <p className="truncate font-medium">
          {node.name}
          {node.ingress && node.outlet ? (
            <Badge variant="muted" className="ml-2 align-middle">
              edge
            </Badge>
          ) : null}
        </p>
        <p className="text-muted-foreground mono-label truncate">{node.hostname}</p>
      </div>

      {editIp ? (
        <div className="flex items-center gap-2">
          <Input
            value={ip}
            onChange={(e) => setIp(e.target.value)}
            placeholder={node.publicIp ?? '203.0.113.10'}
            className="h-8 w-36"
            aria-label={`Public IP override for ${node.name}`}
          />
          <Button
            variant="outline"
            size="sm"
            onClick={() => setPublicIp.mutate({ id: node.id, ip: ip.trim() || null })}
            disabled={setPublicIp.isPending}
          >
            {ip.trim() ? 'Override' : 'Clear'}
          </Button>
          <Button variant="ghost" size="sm" onClick={() => setEditIp(false)}>
            Cancel
          </Button>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setEditIp(true)}
          className="mono-data text-muted-foreground hover:text-foreground text-sm underline-offset-2 hover:underline"
          title="Set a public IP override"
        >
          {node.publicIp ?? 'no public IP'}
        </button>
      )}

      <div className="flex items-center gap-2">
        <Input
          value={region}
          onChange={(e) => setRegion(e.target.value)}
          placeholder="us-east"
          className="h-8 w-32"
          aria-label={`Region for ${node.name}`}
        />
        <Button
          variant="outline"
          size="sm"
          onClick={() => setNodeRegion.mutate({ nodeId: node.id, region })}
          disabled={!region || region === node.region || setNodeRegion.isPending}
        >
          Set region
        </Button>
      </div>
    </div>
  );
}
