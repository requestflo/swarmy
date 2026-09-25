import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';
import { AddDomainCard } from '@/components/ingress/add-domain-card';

/**
 * "Add a domain" from the Network hub: pick the app, then the same form the
 * app's Domains tab uses (one form, one mutation). After adding, the row shows
 * up with the record to create at the registrar.
 */
export function AddDomainDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
}): React.JSX.Element {
  const trpc = useTRPC();
  const stacks = useQuery({ ...trpc.stacks.list.queryOptions(), enabled: open });
  const apps = (stacks.data ?? []).filter((s) => s.name !== 'swarmy-system');
  const [app, setApp] = React.useState('');
  const chosen = app || apps[0]?.name || '';
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Add a domain</DialogTitle>
          <DialogDescription>
            Point an address at one of your apps. swarmy shows you the one record to create, then gets HTTPS by itself.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-1.5">
          <Label htmlFor="add-domain-app">Which app</Label>
          <Select value={chosen} onValueChange={setApp}>
            <SelectTrigger id="add-domain-app" className="sm:w-72">
              <SelectValue placeholder="Pick an app" />
            </SelectTrigger>
            <SelectContent>
              {apps.map((s) => (
                <SelectItem key={s.id} value={s.name}>
                  {s.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        {chosen ? <AddDomainCard key={chosen} stack={chosen} open onOpenChange={(v) => (v ? null : onOpenChange(false))} /> : null}
      </DialogContent>
    </Dialog>
  );
}
