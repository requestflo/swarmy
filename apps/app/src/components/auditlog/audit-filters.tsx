import * as React from 'react';
import { XIcon } from 'lucide-react';
import {
  Button,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@swarmy/ui';
import type { AuditActorKind, AuditFacetsView } from '@swarmy/core';

/** The filter bar's state; `actions` (prefix OR) is set by canned questions. */
export interface AuditFilterState {
  actor: string | null;
  actorType: AuditActorKind | null;
  action: string | null;
  /** Canned-question key; its prefixes are resolved by the page. */
  canned: string | null;
  from: string;
  to: string;
}

export const EMPTY_FILTERS: AuditFilterState = {
  actor: null,
  actorType: null,
  action: null,
  canned: null,
  from: '',
  to: '',
};

const ALL = '__all__';
const ACTOR_TYPES: AuditActorKind[] = ['user', 'apikey', 'system', 'agent'];
const ACTOR_TYPE_LABEL: Record<AuditActorKind, string> = {
  user: 'People',
  apikey: 'API keys',
  system: 'swarmy automation',
  agent: 'Node agents',
};

/** Actor / actor-type / action / date-range filter bar over the facets. */
export function AuditFilters({
  facets,
  value,
  onChange,
}: {
  facets: AuditFacetsView | undefined;
  value: AuditFilterState;
  onChange: (next: AuditFilterState) => void;
}): React.JSX.Element {
  const set = (patch: Partial<AuditFilterState>) => onChange({ ...value, ...patch });
  const isFiltered =
    value.actor !== null ||
    value.actorType !== null ||
    value.action !== null ||
    value.canned !== null ||
    value.from !== '' ||
    value.to !== '';

  return (
    <div className="flex flex-wrap items-center gap-2">
      <Select
        value={value.actor ?? ALL}
        onValueChange={(v) => set({ actor: v === ALL ? null : v })}
      >
        <SelectTrigger className="w-44" aria-label="Filter by actor">
          <SelectValue placeholder="Everyone" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={ALL}>Everyone</SelectItem>
          {(facets?.actors ?? []).map((a) => (
            <SelectItem key={a.id} value={a.id}>
              {a.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      <Select
        value={value.actorType ?? ALL}
        onValueChange={(v) => set({ actorType: v === ALL ? null : (v as AuditActorKind) })}
      >
        <SelectTrigger className="w-44" aria-label="Filter by actor type">
          <SelectValue placeholder="All actor types" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={ALL}>All actor types</SelectItem>
          {(facets?.actorTypes ?? ACTOR_TYPES).map((t) => (
            <SelectItem key={t} value={t}>
              {ACTOR_TYPE_LABEL[t]}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      <Select
        value={value.action ?? ALL}
        onValueChange={(v) => set({ action: v === ALL ? null : v, canned: null })}
      >
        <SelectTrigger className="w-56" aria-label="Filter by action">
          <SelectValue placeholder="All actions" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={ALL}>All actions</SelectItem>
          {(facets?.actions ?? []).map((a) => (
            <SelectItem key={a} value={a}>
              <span className="mono-data text-xs">{a}</span>
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      <Input
        type="date"
        value={value.from}
        onChange={(e) => set({ from: e.target.value })}
        className="w-38"
        aria-label="From date"
      />
      <span className="text-muted-foreground text-xs">to</span>
      <Input
        type="date"
        value={value.to}
        onChange={(e) => set({ to: e.target.value })}
        className="w-38"
        aria-label="To date"
      />

      {isFiltered ? (
        <Button variant="ghost" size="sm" onClick={() => onChange(EMPTY_FILTERS)}>
          <XIcon className="size-4" />
          Clear
        </Button>
      ) : null}
    </div>
  );
}
