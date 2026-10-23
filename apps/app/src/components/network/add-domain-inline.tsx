import * as React from 'react';
import { useNavigate } from '@tanstack/react-router';
import { ArrowRightIcon } from 'lucide-react';
import { Button, Input, Label, Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@swarmy/ui';
import { useTargets } from '@/components/domains/use-add-targets';
import { normalizeHost } from '@/components/domains/host-shape';

/**
 * Board 13's inline "Add a domain": type the address, pick the app, and the
 * existing add-domain flow opens with both filled in (records, then HTTPS).
 */
export function AddDomainInline({ primary }: { primary: boolean }): React.JSX.Element {
  const navigate = useNavigate();
  const { targets } = useTargets();
  const apps = React.useMemo(() => [...new Set(targets.map((t) => t.stack))], [targets]);
  const [host, setHost] = React.useState('');
  const [app, setApp] = React.useState('');
  const hostId = React.useId();

  const go = (e: React.FormEvent): void => {
    e.preventDefault();
    const h = normalizeHost(host);
    void navigate({ to: '/network/domains/new', search: { ...(h ? { host: h } : {}), ...(app ? { app } : {}) } });
  };

  return (
    <form onSubmit={go} className="flex flex-wrap items-end gap-2 pb-2" aria-label="Add a domain">
      <div className="grid min-w-[200px] flex-1 gap-1 sm:max-w-[300px]">
        <Label htmlFor={hostId} className="text-[12.5px]">
          Add a domain
        </Label>
        <Input
          id={hostId}
          value={host}
          onChange={(e) => setHost(e.target.value)}
          placeholder="docs.example.com"
          autoComplete="off"
          spellCheck={false}
          className="font-mono text-[13px]"
        />
      </div>
      <ArrowRightIcon aria-hidden className="text-muted-foreground mb-2.5 hidden size-4 sm:block" />
      <div className="grid min-w-[160px] gap-1">
        <span className="text-muted-foreground text-[12.5px]">Send it to</span>
        <Select value={app} onValueChange={setApp}>
          <SelectTrigger aria-label="Send it to" className="w-full sm:w-[190px]">
            <SelectValue placeholder="Pick an app" />
          </SelectTrigger>
          <SelectContent>
            {apps.map((a) => (
              <SelectItem key={a} value={a}>
                {a}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <Button type="submit" variant={primary ? 'default' : 'outline'} className="pointer-coarse:min-h-11">
        Add
      </Button>
    </form>
  );
}
