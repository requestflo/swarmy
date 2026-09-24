import { createFileRoute, redirect } from '@tanstack/react-router';
import { toast } from '@swarmy/ui';

/**
 * The catch-all for every signed-in path that no longer exists (old global
 * surfaces that dissolved into the stack workspace, stale bookmarks, typos):
 * one toast, then home to the Overview. Replaces the 18 per-path redirect
 * stubs that used to live here. Preloads (link hover) stay silent.
 */
export const Route = createFileRoute('/_authed/$')({
  beforeLoad: ({ preload }) => {
    if (!preload) toast('That page moved.', { description: 'Here’s your Overview instead.' });
    throw redirect({ to: '/overview', replace: true });
  },
});
