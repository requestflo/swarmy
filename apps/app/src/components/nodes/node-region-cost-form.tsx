import * as React from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { DollarSignIcon, MapPinIcon } from 'lucide-react';
import {
  Button,
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

const REGIONS = [
  'us-east',
  'us-west',
  'us-central',
  'ca-central',
  'sa-east',
  'eu-west',
  'eu-central',
  'eu-north',
  'me-south',
  'af-south',
  'ap-south',
  'ap-southeast',
  'ap-northeast',
];

interface NodeRegionCostFormProps {
  nodeId: string;
  region: string | null;
  monthlyUsd: number | null;
}

/** Region (auto-applies on select) + monthly price — both `swarmy.*` node labels. */
export function NodeRegionCostForm({
  nodeId,
  region,
  monthlyUsd,
}: NodeRegionCostFormProps): React.JSX.Element {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const [cost, setCost] = React.useState(monthlyUsd != null ? String(monthlyUsd) : '');

  React.useEffect(() => {
    setCost(monthlyUsd != null ? String(monthlyUsd) : '');
  }, [monthlyUsd]);

  const setRegion = useMutation(
    trpc.nodes.setRegion.mutationOptions({
      onSuccess: (r) => {
        toast.success(`Region set to ${r.region}`);
        void qc.invalidateQueries();
      },
      onError: (e) => toast.error(e.message),
    }),
  );
  const setCostMut = useMutation(
    trpc.nodes.setCost.mutationOptions({
      onSuccess: () => {
        toast.success('Monthly cost saved');
        void qc.invalidateQueries();
      },
      onError: (e) => toast.error(e.message),
    }),
  );

  const options = region && !REGIONS.includes(region) ? [region, ...REGIONS] : REGIONS;
  const costChanged = cost.trim() !== (monthlyUsd != null ? String(monthlyUsd) : '');

  const saveCost = (): void => {
    const trimmed = cost.trim();
    const value = trimmed === '' ? null : Number(trimmed);
    if (value != null && (!Number.isFinite(value) || value < 0)) {
      toast.error('Monthly cost must be a positive number');
      return;
    }
    setCostMut.mutate({ id: nodeId, monthlyUsd: value });
  };

  return (
    <div className="grid gap-4 sm:grid-cols-2">
      <div className="grid gap-1.5">
        <Label className="mono-label flex items-center gap-1.5">
          <MapPinIcon className="size-3.5" /> Region
        </Label>
        <Select
          value={region ?? ''}
          onValueChange={(v) => setRegion.mutate({ id: nodeId, region: v })}
        >
          <SelectTrigger className="w-full">
            <SelectValue placeholder="Unset" />
          </SelectTrigger>
          <SelectContent>
            {options.map((r) => (
              <SelectItem key={r} value={r}>
                {r}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="grid gap-1.5">
        <Label className="mono-label flex items-center gap-1.5">
          <DollarSignIcon className="size-3.5" /> Monthly cost
        </Label>
        <div className="flex gap-2">
          <Input
            type="number"
            min={0}
            step="0.01"
            value={cost}
            placeholder="e.g. 40"
            onChange={(e) => setCost(e.target.value)}
            className="mono-data"
          />
          <Button
            variant="outline"
            disabled={!costChanged || setCostMut.isPending}
            onClick={saveCost}
          >
            Save
          </Button>
        </div>
      </div>
    </div>
  );
}
