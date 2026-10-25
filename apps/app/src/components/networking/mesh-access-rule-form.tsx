import * as React from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Button, Input, Select, SelectContent, SelectItem, SelectTrigger, SelectValue, toast } from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';
import { parsePorts } from './mesh-access-rules-model';

type Protocol = 'tcp' | 'udp' | 'all';

/**
 * Add a simple rule at Controls: one of your NetBird groups may reach another
 * on some ports. One-way, audited (`mesh.rules`); swarmy's own groups and
 * "All" are never offered, so people still reach services only by their grants.
 */
export function MeshAccessRuleForm({ groups }: { groups: string[] }): React.JSX.Element {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const [from, setFrom] = React.useState('');
  const [to, setTo] = React.useState('');
  const [protocol, setProtocol] = React.useState<Protocol>('tcp');
  const [ports, setPorts] = React.useState('');
  const add = useMutation(
    trpc.mesh.rules.add.mutationOptions({
      onSuccess: () => {
        toast.success(`${from} can now reach ${to}`);
        setPorts('');
        void qc.invalidateQueries();
      },
      onError: (e) => toast.error(e.message),
    }),
  );
  const parsed = protocol === 'all' ? [] : parsePorts(ports);
  const portError = typeof parsed === 'string' ? parsed : null;

  const pick = (label: string, value: string, set: (v: string) => void) => (
    <Select value={value} onValueChange={set}>
      <SelectTrigger className="w-44 pointer-coarse:min-h-11" aria-label={label}>
        <SelectValue placeholder={label} />
      </SelectTrigger>
      <SelectContent>
        {groups.map((g) => (
          <SelectItem key={g} value={g}>
            {g}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );

  return (
    <form
      className="border-border flex flex-col gap-2 border-t pt-3"
      onSubmit={(e) => {
        e.preventDefault();
        if (typeof parsed !== 'string') add.mutate({ from, to, protocol, ports: parsed });
      }}
    >
      <h3 className="calm-eyebrow">Add a rule · audited</h3>
      <div className="flex flex-wrap items-center gap-2 text-[13px]">
        {pick('From group', from, setFrom)}
        <span className="text-muted-foreground">can reach</span>
        {pick('To group', to, setTo)}
        <span className="text-muted-foreground">on</span>
        <Select value={protocol} onValueChange={(v) => setProtocol(v as Protocol)}>
          <SelectTrigger className="w-24 pointer-coarse:min-h-11" aria-label="Protocol">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="tcp">TCP</SelectItem>
            <SelectItem value="udp">UDP</SelectItem>
            <SelectItem value="all">every protocol</SelectItem>
          </SelectContent>
        </Select>
        {protocol === 'all' ? null : (
          <Input
            value={ports}
            onChange={(e) => setPorts(e.target.value)}
            placeholder="5432, 6379"
            aria-label="Ports (leave empty for every port)"
            aria-invalid={portError ? true : undefined}
            className="w-40 font-mono pointer-coarse:min-h-11"
          />
        )}
        <Button type="submit" variant="outline" size="sm" disabled={!from || !to || Boolean(portError) || add.isPending} className="pointer-coarse:min-h-11">
          Add rule
        </Button>
      </div>
      {portError ? (
        <p className="text-tone-warn text-[12.5px]">{portError}</p>
      ) : (
        <p className="text-muted-foreground text-[12.5px]">One way, from the first group to the second. Leave the ports empty to allow every port.</p>
      )}
    </form>
  );
}
