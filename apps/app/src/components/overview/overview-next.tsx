import * as React from 'react';
import { Link } from '@tanstack/react-router';
import type { AlertEventView, IncidentView, NodeSummary } from '@swarmy/core';
import { Button } from '@swarmy/ui';
import { NextAction, type Tone } from '@/components/calm';
import type { AppItem } from '@/components/apps/use-apps';
import { relTime } from '@/lib/format';

interface Next {
  tone: Tone;
  title: string;
  body: string;
  tech: string;
  since: string;
  label: string;
  to: string;
  params?: Record<string, string>;
  search?: Record<string, string>;
}

/**
 * The top attention item, worst first: an open incident, a firing alert, an
 * app that needs you, a server that's offline. Null = nothing needs you.
 */
export function pickNext(
  incidents: IncidentView[],
  firing: AlertEventView[],
  apps: AppItem[],
  nodes: NodeSummary[],
): Next | null {
  const inc = incidents[0];
  if (inc) {
    return {
      tone: 'bad', title: inc.title, since: relTime(inc.openedAt), label: 'Open the incident',
      body: `Opened ${relTime(inc.openedAt)}, ${inc.eventCount} update${inc.eventCount === 1 ? '' : 's'} so far. Its page has the timeline and what changed.`,
      tech: `incident ${inc.id} · ${inc.severity}`, to: '/activity', search: { incident: inc.id },
    };
  }
  const al = firing[0];
  if (al) {
    return {
      tone: al.severity === 'critical' ? 'bad' : 'warn', title: al.message, since: relTime(al.firedAt), label: 'See the alert',
      body: `${al.ruleName ?? 'An alert'} on ${al.resource} started firing ${relTime(al.firedAt)}.${firing.length > 1 ? ` ${firing.length - 1} more are firing too.` : ''}`,
      tech: `${al.signal} · ${al.severity} · ${al.resource}`, to: '/alerts',
    };
  }
  const app = apps.find((a) => a.words.tone === 'bad') ?? apps.find((a) => a.words.attention);
  if (app) {
    const svc = app.stat.services.find((s) => s.lastError) ?? app.stat.services.find((s) => s.status !== 'running');
    return {
      tone: app.words.tone, title: `${app.name}: ${app.words.say}`, since: '', label: `Open ${app.name}`,
      body: 'Everything else in the app is fine. Its page shows which part and why, and what you can do.',
      tech: [app.words.tech, svc?.lastError].filter(Boolean).join(' · '), to: '/stacks/$name', params: { name: app.name },
    };
  }
  const node = nodes.find((n) => n.status === 'offline');
  if (node) {
    return {
      tone: 'warn', title: `${node.name} is offline`, since: node.lastSeenAt ? relTime(node.lastSeenAt) : '', label: 'See the server',
      body: `swarmy last heard from it ${node.lastSeenAt ? relTime(node.lastSeenAt) : 'a while ago'}. Its page walks you through bringing it back.`,
      tech: `${node.hostname} · ${node.role} · agent ${node.agentVersion ?? '?'}`, to: '/nodes/$nodeId', params: { nodeId: node.id },
    };
  }
  return null;
}

export function OverviewNext({ next }: { next: Next }): React.JSX.Element {
  return (
    <NextAction
      title={next.title}
      tone={next.tone}
      since={next.since || undefined}
      tech={next.tech}
      actions={
        <Button asChild>
          <Link to={next.to} params={next.params as never} search={next.search as never}>{next.label}</Link>
        </Button>
      }
      hint={
        <>
          or press <kbd className="border-border rounded border px-1 font-mono text-[10.5px]">⌘K</kbd> and ask
        </>
      }
    >
      {next.body}
    </NextAction>
  );
}
