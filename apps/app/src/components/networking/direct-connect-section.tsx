import * as React from 'react';
import { Link } from '@tanstack/react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { SYSTEM_STACK } from '@swarmy/core';
import { Button, toast } from '@swarmy/ui';
import { CalmRow, RowList, Section, Tech } from '@/components/calm';
import { useTRPC } from '@/integrations/trpc';
import { seenAgo, timeLeft } from './mesh-format';

/**
 * Board 43's direct connect: laptop access is per app (its Access tab signs
 * the laptop in and shows what it reaches), so this lists the apps to start
 * from, then every personal grant in the workspace — who reaches what, for
 * how long — with Revoke for admins. Each grant and revoke is audited.
 */
export function DirectConnectSection({ isAdmin }: { isAdmin: boolean }): React.JSX.Element {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const grants = useQuery({ ...trpc.mesh.people.grants.queryOptions(), refetchInterval: 30_000 });
  const stacks = useQuery(trpc.stacks.list.queryOptions());
  const members = useQuery(trpc.members.list.queryOptions());
  const revoke = useMutation(
    trpc.mesh.people.revoke.mutationOptions({
      onSuccess: () => {
        toast.success('Access removed; their laptop loses it within seconds');
        void qc.invalidateQueries();
      },
      onError: (e) => toast.error(e.message),
    }),
  );
  const all = stacks.data ?? [];
  // swarmy's own parts are nobody's laptop target.
  const apps = all.filter((s) => s.name !== SYSTEM_STACK);
  const appName = (ref: string | null): string => (ref ? (all.find((s) => s.id === ref || s.name === ref)?.name ?? ref) : 'an app');
  const who = (userId: string): string => {
    const m = (members.data ?? []).find((x) => x.user.id === userId);
    return m?.user.name || m?.user.email || userId;
  };
  const rows = grants.data ?? [];

  return (
    <Section title="Give my laptop access to one service" hint="per app, on its Access tab">
      <p className="text-muted-foreground text-[13px] leading-relaxed">
        Pick the app. Its Access tab signs your laptop in with swarmy and shows the addresses you can reach; nothing else on the
        private network is.
      </p>
      <div className="flex flex-wrap gap-2">
        {apps.map((s) => (
          <Button key={s.id} asChild variant="outline" size="sm" className="pointer-coarse:min-h-11">
            <Link to="/stacks/$name/access" params={{ name: s.name }}>
              {s.name} →
            </Link>
          </Button>
        ))}
        {stacks.isSuccess && apps.length === 0 ? <span className="text-muted-foreground text-[13px]">No apps yet.</span> : null}
      </div>
      <div className="border-border mt-1 flex flex-col border-t pt-3">
        <h3 className="calm-eyebrow pb-1">Active grants · audited</h3>
        {grants.isPending ? (
          <span className="shimmer-line block h-10 rounded-md" aria-label="Loading grants" />
        ) : rows.length === 0 ? (
          <p className="text-muted-foreground py-2 text-[13px]">No personal grants. People reach apps by their role&apos;s rules only.</p>
        ) : (
          <RowList label="Personal grants">
            {rows.map((g) => (
              <CalmRow
                key={g.id}
                tone="mesh"
                name={`${who(g.userId)} → ${appName(g.stack)}`}
                sub={[g.service, g.port ? `port ${g.port}` : null].filter(Boolean).join(' · ') || 'every service'}
                say={`${timeLeft(g.expiresAt) ?? 'no expiry'} · granted ${seenAgo(g.createdAt) ?? ''}`}
                tech={`mesh.people.grant ${g.id}${g.expiresAt ? ` · expires ${g.expiresAt}` : ''}`}
                trailing={
                  isAdmin ? (
                    <Button variant="outline" size="sm" disabled={revoke.isPending} onClick={() => revoke.mutate({ grantId: g.id })} className="shrink-0 pointer-coarse:min-h-11">
                      Revoke
                    </Button>
                  ) : null
                }
              />
            ))}
          </RowList>
        )}
        <Tech>mesh.people.grants · mesh.people.revoke · audit mesh.access.revoke</Tech>
      </div>
    </Section>
  );
}
