import * as React from 'react';
import { Link } from '@tanstack/react-router';
import { Button } from '@swarmy/ui';
import { NextAction } from '@/components/calm';
import type { AppItem } from '@/components/apps/use-apps';
import type { AppFacts } from './use-app-facts';

/**
 * The app's one next action (the page's only coral button): a part that needs
 * you first, else the worst resilience gap for this app. Nothing → nothing.
 */
export function AppWorthDoing({ app, f }: { app: AppItem; f: AppFacts }): React.JSX.Element | null {
  const stack = app.name;
  if (app.words.attention) {
    const svc = app.stat.services.find((s) => s.status === 'failing' || s.status === 'degraded');
    return (
      <NextAction
        eyebrow="Needs you"
        tone={app.words.tone}
        title={app.words.say}
        tech={[svc?.name, svc ? `${svc.replicas.running}/${svc.replicas.desired} replicas` : null, svc?.lastError].filter(Boolean).join(' · ')}
        actions={
          <Button asChild>
            <Link to="/stacks/$name/observability" params={{ name: stack }}>See what it says</Link>
          </Button>
        }
      >
        The rest of {stack} is fine. Its logs usually say why a part won’t stay up.
      </NextAction>
    );
  }
  const p = f.problems?.[0];
  if (!p) return null;
  return (
    <NextAction
      eyebrow="Worth doing"
      tone={p.severity === 'crit' ? 'bad' : p.severity === 'info' ? 'info' : 'warn'}
      title={p.title}
      tech={`${p.check}${p.resource ? ` · ${p.resource}` : ''} · ${p.detail} ${p.fixHint}`}
      actions={
        <Button asChild>
          <Link to={p.fixPath}>{p.fixLabel}</Link>
        </Button>
      }
    >
      If a server fails, this is where {stack} could stop. Fixing it takes a few minutes and changes nothing else.
    </NextAction>
  );
}
