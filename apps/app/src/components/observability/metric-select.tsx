import * as React from 'react';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@swarmy/ui';
import { METRIC_PRESETS } from './observability-shared';

interface MetricSelectProps {
  value: string;
  onChange: (value: string) => void;
}

/** Metric preset picker — shared by the metrics + by-service panels. */
export function MetricSelect({ value, onChange }: MetricSelectProps): React.JSX.Element {
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger className="h-8 w-[170px] rounded-full text-xs font-medium">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {METRIC_PRESETS.map((m) => (
          <SelectItem key={m.value} value={m.value}>
            {m.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
