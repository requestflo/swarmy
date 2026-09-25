import * as React from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { UsersIcon } from 'lucide-react';
import { Button, Switch, toast } from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';
import { GroupPicker } from './group-picker';
import { PeoplePicker } from './people-picker';
import type { AppAccessRules, AppAccessViewData } from './types';

interface WhoCanEnterCardProps {
  stack: string;
  view: AppAccessViewData;
}

const same = (a: AppAccessRules, b: AppAccessRules): boolean =>
  a.everyone === b.everyone &&
  [...a.groups].sort().join() === [...b.groups].sort().join() &&
  [...a.people].sort().join() === [...b.people].sort().join();

/** Who can enter: everyone in the org, groups (SSO groups included), or named people. Written as access rules. */
export function WhoCanEnterCard({ stack, view }: WhoCanEnterCardProps): React.JSX.Element {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const [draft, setDraft] = React.useState<AppAccessRules>(view.rules);
  React.useEffect(() => setDraft(view.rules), [view.rules]);
  const save = useMutation(
    trpc.appAccess.setRules.mutationOptions({
      onSuccess: () => {
        toast.success('Saved. Changes apply within seconds.');
        void qc.invalidateQueries();
      },
      onError: (e) => toast.error(e.message),
    }),
  );
  const entering = view.people.filter((p) => p.canEnter).length;
  const dirty = !same(draft, view.rules);

  return (
    <section className="space-y-4">
      <div>
        <h2 className="say text-xl">
          Who can <em>enter</em>
        </h2>
        <p className="text-muted-foreground mono-label mt-1">
          {entering} / {view.people.length} people · owners and admins always can
        </p>
      </div>

      <div className="calm-card shadow-none space-y-5 p-5">
        <label className="flex items-center justify-between gap-4">
          <span>
            <span className="font-semibold">Everyone in this organisation</span>
            <span className="text-muted-foreground block text-sm">Any member who signs in to swarmy.</span>
          </span>
          <Switch checked={draft.everyone} onCheckedChange={(v) => setDraft({ ...draft, everyone: v })} />
        </label>
        {!draft.everyone ? (
          <>
            <GroupPicker known={view.knownGroups} value={draft.groups} onChange={(groups) => setDraft({ ...draft, groups })} />
            <PeoplePicker people={view.people} value={draft.people} onChange={(people) => setDraft({ ...draft, people })} />
          </>
        ) : null}
        <div className="flex flex-wrap items-center justify-end gap-3">
          {dirty ? (
            <Button variant="ghost" onClick={() => setDraft(view.rules)}>
              Discard
            </Button>
          ) : null}
          <Button variant="outline" disabled={!dirty || save.isPending} onClick={() => save.mutate({ stack, ...draft })}>
            <UsersIcon className="size-4" /> Save access
          </Button>
        </div>
      </div>
    </section>
  );
}
