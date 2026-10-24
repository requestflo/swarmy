import * as React from 'react';
import { useMutation } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { toast } from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';
import { giteaReady, type GiteaMode, type GiteaTest } from './git-gitea-model';
import { goToProvider } from './git-nav';
import { rememberGitReturn, type GitReturn } from './git-return';

type Field = 'baseUrl' | 'token' | 'clientId' | 'clientSecret';

/**
 * The Gitea / Forgejo card's state: mode, the four fields, "Test connection"
 * (read-only, `gitConnections.testGitea`) and connect (`gitConnections.create`).
 * Editing any field clears a stale test result.
 */
export function useGiteaConnect(onConnected: () => void, returnTo?: GitReturn['to']) {
  const trpc = useTRPC();
  const navigate = useNavigate();
  const [mode, setModeRaw] = React.useState<GiteaMode>('token');
  const [form, setForm] = React.useState<Record<Field, string>>({ baseUrl: '', token: '', clientId: '', clientSecret: '' });
  const [tested, setTested] = React.useState<GiteaTest | null>(null);

  const set = (k: Field) => (v: string): void => {
    setForm((f) => ({ ...f, [k]: v }));
    setTested(null);
  };
  const setMode = (m: GiteaMode): void => {
    setModeRaw(m);
    setTested(null);
  };

  const test = useMutation(
    trpc.gitConnections.testGitea.mutationOptions({
      onSuccess: (r) => setTested(r),
      onError: (e) => setTested({ ok: false, status: null, error: e.message }),
    }),
  );
  const create = useMutation(
    trpc.gitConnections.create.mutationOptions({
      onSuccess: (res) => {
        if (res.authorizeUrl) {
          rememberGitReturn(returnTo ? { to: returnTo } : null);
          return goToProvider(res.authorizeUrl, navigate);
        }
        const who = res.connection.account ? ` as ${res.connection.account}` : '';
        toast.success(`${res.connection.displayName} is connected${who}.`);
        onConnected();
      },
      onError: (e) => toast.error(e.message),
    }),
  );

  const baseUrl = form.baseUrl.trim().replace(/\/+$/, '');
  const runTest = (): void =>
    test.mutate({ baseUrl, ...(mode === 'token' && form.token.trim() ? { token: form.token.trim() } : {}) });
  const submit = (): void =>
    mode === 'token'
      ? create.mutate({ kind: 'gitea', mode, baseUrl, token: form.token.trim() })
      : create.mutate({ kind: 'gitea', mode, baseUrl, clientId: form.clientId.trim(), clientSecret: form.clientSecret });

  return { mode, setMode, form, set, tested, test, create, runTest, submit, ready: giteaReady(mode, form) };
}

export type GiteaConnect = ReturnType<typeof useGiteaConnect>;
