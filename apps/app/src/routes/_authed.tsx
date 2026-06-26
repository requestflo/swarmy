import { Outlet, createFileRoute, redirect } from '@tanstack/react-router';
import { authClient } from '@swarmy/auth/client';
import { AppShell } from '@/components/shell/app-shell';

export const Route = createFileRoute('/_authed')({
  beforeLoad: async () => {
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
