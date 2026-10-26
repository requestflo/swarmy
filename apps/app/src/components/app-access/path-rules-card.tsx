import * as React from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { TriangleAlertIcon, XIcon } from 'lucide-react';
import { ruleKey, type AppPathRule } from '@swarmy/core';
import { Button, toast } from '@swarmy/ui';
import { Tech } from '@/components/calm';
import { useTRPC } from '@/integrations/trpc';
import { PathRuleForm } from './path-rule-form';
import { rulePath, ruleWho } from './path-rules-model';
import type { AppAccessRoute, AppAccessViewData } from './types';

/**
 * Who can enter each path (Controls): per protected address, rules like
 * "/admin → group admins only". They narrow who-can-enter above — the most
 * specific path decides — and live with the address on its route label.
 */
export function PathRulesCard({ stack, view }: { stack: string; view: AppAccessViewData }): React.JSX.Element {
  const locked = view.routes.filter((r) => !r.endUserAuth && r.requireLogin);
  return (
    <section className="space-y-4">
      <div>
        <h2 className="say text-xl">
          Who can enter <em>each path</em>
        </h2>
        <p className="text-muted-foreground mt-1 max-w-2xl text-sm">
          Keep part of the app to fewer people, like /admin for one group. A path rule only narrows who can enter above, and the
          most specific path wins.
        </p>
      </div>
      {locked.length === 0 ? (
        <p className="text-muted-foreground text-sm">Turn on Require login for an address first.</p>
      ) : (
        locked.map((r) => <RouteRules key={r.id} stack={stack} route={r} view={view} />)
      )}
    </section>
  );
}

function RouteRules({ stack, route, view }: { stack: string; route: AppAccessRoute; view: AppAccessViewData }): React.JSX.Element {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const save = useMutation(
    trpc.appAccess.setPathRules.mutationOptions({
      onSuccess: () => {
        toast.success('Saved. The front door uses it within seconds.');
        void qc.invalidateQueries();
      },
      onError: (e) => toast.error(e.message),
    }),
  );
  const put = (rules: AppPathRule[]): void => save.mutate({ stack, routeId: route.id, rules });
  const where = route.path === '/' ? route.host : `${route.host}${route.path}`;

  return (
    <div className="calm-card shadow-none overflow-hidden">
      <div className="flex flex-wrap items-center justify-between gap-2 px-5 pt-4 pb-2">
        <span className="mono-data">{where}</span>
        <Tech>{`swarmy.ingress.routes → access.paths (${route.pathRules.length})`}</Tech>
      </div>
      {route.pathRulesError ? (
        <div className="text-tone-bad flex items-start gap-2 px-5 pb-3 text-sm" role="alert">
          <TriangleAlertIcon className="mt-0.5 size-4 shrink-0" />
          The path rules on this address can’t be read, so nobody gets in. Save new rules to replace them.
          <Button variant="outline" size="sm" className="ml-auto" disabled={save.isPending} onClick={() => put([])}>
            Clear them
          </Button>
        </div>
      ) : null}
      {route.pathRules.length === 0 && !route.pathRulesError ? (
        <p className="text-muted-foreground px-5 pb-3 text-sm">No path rules: everyone the app lets in can open every page.</p>
      ) : (
        <ul className="divide-border divide-y px-5">
          {route.pathRules.map((rule) => (
            <li key={rule.path} className="flex items-center gap-3 py-2.5">
              <span className="mono-data w-40 shrink-0 truncate">{rulePath(rule)}</span>
              <span className="text-muted-foreground min-w-0 flex-1 text-sm">{rule.everyone ? 'Everyone the app lets in.' : `Only ${ruleWho(rule, view.people)}.`}</span>
              <Button
                variant="ghost"
                size="icon"
                className="size-8 pointer-coarse:size-11"
                aria-label={`Remove the rule on ${rulePath(rule)}`}
                disabled={save.isPending}
                onClick={() => put(route.pathRules.filter((x) => x !== rule))}
              >
                <XIcon className="size-4" />
              </Button>
            </li>
          ))}
        </ul>
      )}
      <PathRuleForm
        view={view}
        taken={route.pathRules.map((r) => ruleKey(r.path) ?? r.path)}
        pending={save.isPending}
        onAdd={(rule) => put([...route.pathRules, rule])}
      />
    </div>
  );
}
