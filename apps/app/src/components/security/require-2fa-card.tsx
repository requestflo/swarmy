import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Input,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Skeleton,
  Switch,
  toast,
} from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';

type Require2fa = 'off' | 'admins' | 'all';

const LABELS: Record<Require2fa, string> = {
  off: 'Off',
  admins: 'Owners and admins',
  all: 'Everyone',
};

/** Org policy: require 2FA for admins / everyone, grace period, SSO trust. */
export function Require2faCard(): React.JSX.Element {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const policy = useQuery(trpc.security.policy.get.queryOptions());
  const [draft, setDraft] = React.useState<{ require2fa: Require2fa; graceDays: number; trustIdpMfa: boolean } | null>(
    null,
  );
  React.useEffect(() => {
    if (policy.data) setDraft({ ...policy.data });
  }, [policy.data]);

  const save = useMutation(
    trpc.security.policy.set.mutationOptions({
      onSuccess: () => {
        toast.success('Security policy saved');
        void qc.invalidateQueries();
      },
      onError: (e) => toast.error(e.message),
    }),
  );

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Require two-factor</CardTitle>
      </CardHeader>
      <CardContent>
        {!draft ? (
          <Skeleton className="h-24 w-full" />
        ) : (
          <form
            className="grid gap-4 sm:grid-cols-2"
            onSubmit={(e) => {
              e.preventDefault();
              save.mutate(draft);
            }}
          >
            <div className="space-y-1.5">
              <Label>Who must use two-factor</Label>
              <Select value={draft.require2fa} onValueChange={(v) => setDraft({ ...draft, require2fa: v as Require2fa })}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {(Object.keys(LABELS) as Require2fa[]).map((k) => (
                    <SelectItem key={k} value={k}>
                      {LABELS[k]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="grace-days">Grace period (days)</Label>
              <Input
                id="grace-days"
                type="number"
                min={0}
                max={30}
                value={draft.graceDays}
                onChange={(e) => setDraft({ ...draft, graceDays: Number(e.target.value) })}
              />
            </div>
            <label className="flex items-start gap-3 text-sm sm:col-span-2">
              <Switch checked={draft.trustIdpMfa} onCheckedChange={(v) => setDraft({ ...draft, trustIdpMfa: v })} />
              <span>
                Trust SSO providers’ MFA
                <span className="text-muted-foreground block">
                  People who only sign in with SSO or GitHub/Google are exempt. Their identity provider owns MFA.
                </span>
              </span>
            </label>
            <p className="text-muted-foreground text-sm sm:col-span-2">
              Members get the grace period from when you turn this on, or from when they join if that is later.
              After that they can only reach the two-factor setup screen until they enrol.
            </p>
            <div className="sm:col-span-2">
              <Button type="submit" disabled={save.isPending}>
                Save
              </Button>
            </div>
          </form>
        )}
      </CardContent>
    </Card>
  );
}
