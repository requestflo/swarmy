import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTRPC } from '@/integrations/trpc';
import { useApps } from '@/components/apps/use-apps';
import type { IntentWorld } from '@/lib/intents';

/** What the ⌘K intents can name: apps (with their addresses), their parts, templates and servers. */
export function useIntentWorld(): IntentWorld {
  const trpc = useTRPC();
  const a = useApps();
  const templates = useQuery(trpc.blueprints.list.queryOptions());
  const nodes = useQuery(trpc.nodes.list.queryOptions());
  return React.useMemo(() => {
    const all = [...a.apps, ...a.platform];
    return {
      apps: all.map((x) => ({ name: x.name, hosts: x.hosts })),
      parts: all.flatMap((x) =>
        x.stat.services.map((s) => ({ id: s.id, name: s.name.replace(`${x.name}_`, ''), app: x.name, desired: s.replicas.desired })),
      ),
      templates: (templates.data ?? []).filter((t) => !t.docOnly).map((t) => ({ id: t.id, name: t.name })),
      servers: (nodes.data ?? []).map((n) => n.name),
    };
  }, [a.apps, a.platform, templates.data, nodes.data]);
}

/** The TRY chips: the board's "deploy ghost as blog" first, then ones that name this estate. */
export function tryExamples(world: IntentWorld): string[] {
  const t = world.templates.find((x) => x.id === 'ghost') ?? world.templates[0];
  const deploy = t ? (t.id === 'ghost' ? 'deploy ghost as blog' : `deploy ${t.id}`) : null;
  const app = world.apps[0]?.name;
  const part = world.parts.find((p) => p.app === app)?.name;
  const mine = app ? [`undo ${app}`, `add a domain to ${app}`, part ? `restart ${part}` : null, `why is ${app} slow`] : [];
  return [deploy, ...mine].filter((x): x is string => !!x);
}
