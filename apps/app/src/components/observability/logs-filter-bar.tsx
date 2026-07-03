import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { SearchIcon } from 'lucide-react';
import {
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Switch,
  cn,
} from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';
import {
  LOG_RANGE_PRESETS,
  LOG_SEVERITY_CHIPS,
  type LogFilters,
  type LogRangePreset,
} from './logs-shared';
import { useStackServiceNames } from './use-stack-services';

const ALL_SERVICES = '__all__';

interface LogsFilterBarProps {
  filters: LogFilters;
  onChange: (filters: LogFilters) => void;
  live: boolean;
  onLiveChange: (live: boolean) => void;
  /** Limit the service select to one stack's services. */
  stack?: string;
}

/** Service select + severity chips + debounced search + range presets + live. */
export function LogsFilterBar({
  filters,
  onChange,
  live,
  onLiveChange,
  stack,
}: LogsFilterBarProps): React.JSX.Element {
  const trpc = useTRPC();
  const services = useQuery({ ...trpc.services.list.queryOptions({}), enabled: !stack });
  const stackNames = useStackServiceNames(stack);
  const serviceNames = React.useMemo(
    () =>
      stack ? stackNames.names : [...new Set((services.data ?? []).map((s) => s.name))].sort(),
    [stack, stackNames.names, services.data],
  );

  // Local, debounced search so typing doesn't fire a query per keystroke.
  const [search, setSearch] = React.useState(filters.search);
  React.useEffect(() => setSearch(filters.search), [filters.search]);
  React.useEffect(() => {
    if (search === filters.search) return;
    const t = setTimeout(() => onChange({ ...filters, search }), 350);
    return () => clearTimeout(t);
  }, [search, filters, onChange]);

  return (
    <div className="flex flex-wrap items-center gap-2 px-6 pb-4">
      <Select
        value={filters.serviceName ?? ALL_SERVICES}
        onValueChange={(v) =>
          onChange({ ...filters, serviceName: v === ALL_SERVICES ? undefined : v })
        }
      >
        <SelectTrigger className="h-8 w-[150px] rounded-full text-xs font-medium">
          <SelectValue placeholder="All services" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={ALL_SERVICES}>All services</SelectItem>
          {serviceNames.map((name) => (
            <SelectItem key={name} value={name}>
              {name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      <div className="flex items-center gap-1">
        {LOG_SEVERITY_CHIPS.map((chip) => (
          <button
            key={chip.label}
            type="button"
            onClick={() => onChange({ ...filters, severityMin: chip.min })}
            className={cn(
              'rounded-full px-2.5 py-1 text-xs font-medium transition-colors',
              filters.severityMin === chip.min
                ? 'bg-ink text-ink-foreground'
                : 'bg-muted text-muted-foreground hover:bg-accent',
            )}
          >
            {chip.label}
          </button>
        ))}
      </div>

      <div className="relative min-w-[160px] flex-1">
        <SearchIcon className="text-muted-foreground absolute left-3 top-1/2 size-3.5 -translate-y-1/2" />
        <Input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search log bodies…"
          className="h-8 rounded-full pl-8 text-xs"
        />
      </div>

      <div className="flex items-center gap-1">
        {LOG_RANGE_PRESETS.map((p) => (
          <button
            key={p.value}
            type="button"
            onClick={() => onChange({ ...filters, range: p.value as LogRangePreset })}
            className={cn(
              'mono-data rounded-full px-2.5 py-1 text-xs transition-colors',
              filters.range === p.value
                ? 'bg-ink text-ink-foreground'
                : 'bg-muted text-muted-foreground hover:bg-accent',
            )}
          >
            {p.label}
          </button>
        ))}
      </div>

      <label className="text-muted-foreground flex items-center gap-2 text-xs font-medium">
        {live ? <span className="pulse-dot" /> : null}
        Live
        <Switch checked={live} onCheckedChange={onLiveChange} />
      </label>
    </div>
  );
}
