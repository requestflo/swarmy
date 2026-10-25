import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, toast } from '@swarmy/ui';
import { CalmRow, Depth, RowList, Section, Tech } from '@/components/calm';
import { useTRPC } from '@/integrations/trpc';
import { MeshAccessRuleForm } from './mesh-access-rule-form';
import { rulesCount } from './mesh-access-rules-model';

/**
 * Board 43's access rules: who can reach whom on the private network, in
 * plain words ("Servers can reach Databases on 5432"), read live from the
 * control plane (NetBird policies; no swarmy copy). At Controls an admin adds
 * a simple rule between their own groups or removes one; swarmy's own rules
 * (servers ↔ servers, people access) are shown, never changed here.
 */
export function MeshAccessRulesSection({ isAdmin }: { isAdmin: boolean }): React.JSX.Element {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const rules = useQuery({ ...trpc.mesh.rules.list.queryOptions(), refetchInterval: 60_000 });
  const remove = useMutation(
    trpc.mesh.rules.remove.mutationOptions({
      onSuccess: () => {
        toast.success('Rule removed; the private network stops allowing it within seconds');
        void qc.invalidateQueries();
      },
      onError: (e) => toast.error(e.message),
    }),
  );
  const v = rules.data;

  return (
    <Section title="Who can reach whom" count={v?.supported ? rulesCount(v.rules) : undefined} hint="read live from the control plane" flush>
      {!v ? (
        <span className="shimmer-line mb-3 block h-10 rounded-md" aria-label="Loading access rules" />
      ) : !v.supported ? (
        <p className="text-muted-foreground pb-3 text-[13px]">{v.note}</p>
      ) : v.error ? (
        <p className="text-tone-warn pb-3 text-[13px]">{v.error}</p>
      ) : (
        <>
          {v.rules.length === 0 ? (
            <p className="text-muted-foreground pb-3 text-[13px]">No rules: nothing on the private network can reach anything else yet.</p>
          ) : (
            <RowList label="Access rules on the private network">
              {v.rules.map((r) => (
                <CalmRow
                  key={r.id}
                  tone={r.enabled ? 'mesh' : 'idle'}
                  name={r.managedBySwarmy ? 'Kept by swarmy' : r.name}
                  say={r.words}
                  tech={`${r.protocol}${r.ports.length ? `/${r.ports.join(',')}` : ''}${r.bidirectional ? ' · both ways' : ''}`}
                  word={r.enabled ? 'On' : 'Off'}
                  wordTone={r.enabled ? 'ok' : 'idle'}
                  trailing={
                    isAdmin && r.simple && !r.managedBySwarmy ? (
                      <Depth at="controls">
                        <Button variant="outline" size="sm" disabled={remove.isPending} onClick={() => remove.mutate({ id: r.id })} className="shrink-0 pointer-coarse:min-h-11">
                          Remove
                        </Button>
                      </Depth>
                    ) : null
                  }
                />
              ))}
            </RowList>
          )}
          <Depth at="controls">
            <div className="flex flex-col gap-2 pb-3">
              {!isAdmin ? null : v.groups.length ? (
                <MeshAccessRuleForm groups={v.groups} />
              ) : (
                <p className="text-muted-foreground border-border border-t pt-3 text-[13px]">
                  Your control plane has no groups of its own yet. Rules between your own NetBird groups show up here, and you can add them.
                </p>
              )}
              <Tech>mesh.rules.list · mesh.rules.add · mesh.rules.remove · audit mesh.rule.add / mesh.rule.remove</Tech>
            </div>
          </Depth>
        </>
      )}
    </Section>
  );
}
