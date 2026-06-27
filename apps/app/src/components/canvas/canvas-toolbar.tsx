import * as React from 'react';
import { useNavigate } from '@tanstack/react-router';
import { useReactFlow, Panel } from '@xyflow/react';
import { MaximizeIcon, RocketIcon } from 'lucide-react';
import {
  Button,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@swarmy/ui';

interface StackOption {
  id: string;
  name: string;
}

/** Floating canvas chrome: wayfinding + stack filter + fit-view + the one coral CTA. */
export function CanvasToolbar({
  count,
  stacks,
  stackFilter,
  onStackFilter,
}: {
  count: number;
  stacks: StackOption[];
  stackFilter: string;
  onStackFilter: (value: string) => void;
}): React.JSX.Element {
  const navigate = useNavigate();
  const { fitView } = useReactFlow();

  return (
    <>
      <Panel position="top-left" className="!m-4">
        <div className="card-pop flex items-center gap-3 rounded-full py-2 pr-2 pl-4">
          <div>
            <p className="eyebrow !mb-0">Applications</p>
          </div>
          <span className="mono-data text-muted-foreground text-xs">{count} services</span>
          {stacks.length > 0 && (
            <Select value={stackFilter} onValueChange={onStackFilter}>
              <SelectTrigger className="h-8 w-40 rounded-full">
                <SelectValue placeholder="All stacks" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All stacks</SelectItem>
                {stacks.map((s) => (
                  <SelectItem key={s.id} value={s.id}>
                    {s.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        </div>
      </Panel>

      <Panel position="top-right" className="!m-4">
        <div className="flex items-center gap-2">
          <Button variant="outline" size="icon" className="rounded-full" onClick={() => fitView({ duration: 400 })} aria-label="Fit to view">
            <MaximizeIcon className="size-4" />
          </Button>
          <Button className="gap-2" onClick={() => navigate({ to: '/services/new' })}>
            <RocketIcon className="size-4" /> Deploy
          </Button>
        </div>
      </Panel>
    </>
  );
}
