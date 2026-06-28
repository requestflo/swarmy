import { Outlet, createFileRoute, redirect } from '@tanstack/react-router';
import { authClient } from '@swarmy/auth/client';
import { AppShell } from '@/components/shell/app-shell';
import { isDemo } from '@/demo/is-demo';

export const Route = createFileRoute('/_authed')({
  beforeLoad: async () => {
    // Demo mode runs with no auth — the whole app is explorable read/write
    // against the in-memory store.
    if (isDemo()) return;
    const { data } = await authClient.getSession();
    if (!data?.session) {
      throw redirect({ to: '/login' });
    }
  },
  component: AuthedLayout,
});

function AuthedLayout() {
  return (
    <AppShell>
      <Outlet />
    </AppShell>
  );
}
