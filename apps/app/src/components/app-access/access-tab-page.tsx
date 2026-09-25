import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, toast } from '@swarmy/ui';
import { CalmRow, Depth, NextAction, RowList, Say, SayHeader, Section } from '@/components/calm';
import { ErrorState, PageSkeleton } from '@/components/states';
import { useTRPC } from '@/integrations/trpc';
import { ConnectFromLaptop } from '@/components/networking/connect-from-laptop';
import { AccessCode } from './access-code';
import { AppAccessSection } from './app-access-section';
import type { AppAccessRoute, AppAccessViewData } from './types';

const PRIVATE_PATH = /^\/(admin|internal|staff|ops|dashboard)\b/i;

function whoWords(v: AppAccessViewData): string {
  if (v.rules.everyone) return 'everyone in your organisation';
  const parts = [...v.rules.groups.map((g) => `group ${g}`), ...v.rules.people.map((p) => v.people.find((x) => x.memberId === p)?.name ?? p)];
  return parts.length ? parts.join(', ') : 'nobody yet';
}

/**
 * The app's Access tab (AppAccess board): who can open the app, in a
 * sentence; each address as a row ("anyone" / "signs in first"); one next
 * action when an admin-looking path is open to the world. Controls: the
 * Require login / who can enter / own users cards and laptop access.
 */
export function AccessTabPage({ stack }: { stack: string }): React.JSX.Element {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const q = useQuery({ ...trpc.appAccess.get.queryOptions({ stack }), refetchInterval: 10_000 });
  const lock = useMutation(trpc.appAccess.setRequireLogin.mutationOptions({ onSuccess: () => void qc.invalidateQueries(), onError: (e) => toast.error(e.message) }));
  if (q.isPending) return <PageSkeleton className="px-0 pt-0 xl:px-0" />;
  if (q.isError) return <ErrorState error={q.error} retry={() => void q.refetch()} retrying={q.isFetching} />;

  const v = q.data as AppAccessViewData;
  const routes = v.routes.filter((r) => !r.endUserAuth);
  const locked = routes.filter((r) => r.requireLogin);
  const exposed: AppAccessRoute | undefined = routes.find((r) => !r.requireLogin && PRIVATE_PATH.test(r.path));
  const who = whoWords(v);
  const title =
    routes.length === 0 ? (
      <>{stack} has no address yet, so nobody can open it.</>
    ) : locked.length === 0 ? (
      <>Anyone on the internet can open {stack}. {exposed ? <Say tone="warn">That includes {exposed.path}.</Say> : null}</>
    ) : (
      <>
        {locked.length} of {routes.length} addresses ask people to sign in. <em>Only {who} get in.</em>
      </>
    );
  const lede = v.endUserAuth
    ? `Your customers sign in with ${v.endUserAuth.providers.join(', ') || 'email'}${v.endUserAuth.email !== 'none' ? ` and ${v.endUserAuth.email}` : ''}, handled by swarmy’s own sign-in service.`
    : 'swarmy checks who someone is at the front door, before a request reaches the app. The app needs no login code.';

  return (
    <div className="flex flex-col gap-5 pb-8">
      <SayHeader size="md" title={title} lede={lede} />
      <AccessCode view={v} />
      {exposed ? (
        <NextAction
          title={`Ask people to sign in before ${exposed.host}${exposed.path}`}
          tech={`swarmy.ingress.routes → { host: ${exposed.host}, path: ${exposed.path}, access: { login: true } }`}
          actions={
            <Button disabled={lock.isPending} onClick={() => lock.mutate({ stack, on: true, routeIds: [exposed.id] })}>
              {lock.isPending ? 'Turning on…' : 'Require sign-in'}
            </Button>
          }
        >
          It looks private but anyone can open it. After this, only {who} can.
        </NextAction>
      ) : null}
      <Depth only="summary">
        {routes.length > 0 ? (
          <Section title="Who can open each address" count={routes.length} flush>
            <RowList label="Addresses">
              {routes.map((r) => (
                <CalmRow key={r.id} tone={r.requireLogin ? 'mesh' : 'idle'} name={`${r.host}${r.path !== '/' ? r.path : ''}`} sub={r.serviceName.replace(`${stack}_`, '')}
                  say={r.requireLogin ? `Signs in first. ${who[0]?.toUpperCase()}${who.slice(1)}.` : 'Anyone, no sign-in.'} word={r.requireLogin ? 'Sign-in' : 'Public'} wordTone={r.requireLogin ? 'mesh' : 'idle'} />
              ))}
            </RowList>
          </Section>
        ) : null}
      </Depth>
      <Depth at="controls">
        <AppAccessSection stack={stack} />
        <ConnectFromLaptop stack={stack} />
      </Depth>
    </div>
  );
}
