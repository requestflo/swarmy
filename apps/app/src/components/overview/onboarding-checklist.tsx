import * as React from 'react';
import { Link } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { ActivityIcon, BellIcon, DatabaseBackupIcon, RocketIcon, ServerIcon } from 'lucide-react';
import { cn } from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';

interface OnboardingChecklistProps {
  hasNodes: boolean;
  /** Any service deployed anywhere on the swarm. */
  hasServices?: boolean;
  /** Any notification channel configured (alerts can actually reach someone). */
  hasAlertChannel?: boolean;
}

/**
 * Five steps to a production-grade platform — the ink-block CTA strip. Node /
 * service / alert-channel state arrives via props (the Overview already runs
 * those queries); domain + backup state is fetched here so every tick reflects
 * reality instead of a hardcoded `false`.
 */
export function OnboardingChecklist({
  hasNodes,
  hasServices = false,
  hasAlertChannel = false,
}: OnboardingChecklistProps): React.JSX.Element {
  const trpc = useTRPC();
  const ingress = useQuery({ ...trpc.ingress.getConfig.queryOptions(), enabled: hasNodes });
  const targets = useQuery({ ...trpc.backups.listTargets.queryOptions(), enabled: hasNodes });

  const steps = [
    { done: hasNodes, label: 'Add your first node', to: '/nodes/new', icon: <ServerIcon className="size-4" /> },
    { done: hasServices, label: 'Deploy a service or a blueprint', to: '/blueprints', icon: <RocketIcon className="size-4" /> },
    { done: (ingress.data?.domainCount ?? 0) > 0, label: 'Point a domain at it', to: '/ingress', icon: <ActivityIcon className="size-4" /> },
    { done: (targets.data?.length ?? 0) > 0, label: 'Set up backups', to: '/backups', icon: <DatabaseBackupIcon className="size-4" /> },
    { done: hasAlertChannel, label: 'Turn on alerts', to: '/alerts', icon: <BellIcon className="size-4" /> },
  ];
  return (
    <div className="ink-block mt-4 rounded-2xl p-6">
      <h2 className="font-display text-ink-foreground text-lg font-bold">Get set up</h2>
      <p className="text-ink-foreground/60 mt-1 text-sm">Five steps to a production-grade platform.</p>
      <div className="mt-4 grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-3">
        {steps.map((s) => (
          <Link
            key={s.label}
            to={s.to}
            className={cn(
              'flex items-center gap-3 rounded-xl px-3 py-2.5 transition-colors',
              s.done ? 'bg-white/5' : 'bg-white/5 hover:bg-white/10',
            )}
          >
            <span
              className={cn(
                'flex size-6 shrink-0 items-center justify-center rounded-full text-xs',
                s.done ? 'bg-status-online/20 text-status-online' : 'bg-white/10 text-ink-foreground/70',
              )}
            >
              {s.done ? '✓' : s.icon}
            </span>
            <span className={cn('text-sm', s.done ? 'text-ink-foreground/50 line-through' : 'text-ink-foreground')}>
              {s.label}
            </span>
          </Link>
        ))}
      </div>
    </div>
  );
}
