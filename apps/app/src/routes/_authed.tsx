import { Outlet, createFileRoute, redirect } from '@tanstack/react-router';
import { AppShell } from '@/components/shell/app-shell';
import { isDemo } from '@/demo/is-demo';
import { hasLiveSession } from '@/integrations/trpc-auth';

export const Route = createFileRoute('/_authed')({
  beforeLoad: async ({ location }) => {
    // Demo mode runs with no auth — the whole app is explorable read/write
    // against the in-memory store.
    if (isDemo()) return;
    // One empty answer isn't a sign-out: hasLiveSession re-checks once with the
    // cookie cache bypassed before we eject the user.
    if (!(await hasLiveSession())) {
      throw redirect({ to: '/login', search: { redirect: location.href } });
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
