import * as React from 'react';
import { Link } from '@tanstack/react-router';
import { cn } from '@swarmy/ui';
import { Depth, TONE_DOT, TONE_TEXT } from '@/components/calm';
import { TextSkeleton } from '@/components/states';
import { serverTone, techRoles } from '@/components/nodes/servers/server-words';
import type { ServerView } from './estate-model';
import type { Lens } from './lens-control';
import { RingGauge } from './ring-gauge';

const MESH_WORDS = { connected: 'on the private network', joining: 'joining the private network', off: 'not on the private network' } as const;

/** The lens line: size (Traffic), private-network state (Mesh) or the price (Cost). */
function LensLine({ s, lens }: { s: ServerView; lens: Lens }): React.JSX.Element {
  if (lens === 'mesh') {
    return (
      <span className={cn('flex items-center gap-1.5', s.mesh.state === 'connected' ? 'text-tone-mesh' : 'text-muted-foreground')}>
        <span aria-hidden className={cn('size-1.5 rounded-full', s.mesh.state === 'off' ? 'bg-status-idle' : 'bg-tone-mesh')} />
        {MESH_WORDS[s.mesh.state]}
      </span>
    );
  }
  if (lens === 'cost') {
    if (s.cost === undefined) return <TextSkeleton className="w-16" />;
    return s.cost === null ? <span className="text-muted-foreground">no price set</span> : <span className="text-foreground font-semibold">${Math.round(s.cost)} a month</span>;
  }
  const busy = s.busy ? `${s.busy.pct}% ${s.busy.which}` : null;
  return (
    <span className="text-muted-foreground">
      {busy ? <span className={s.busy!.pct >= 85 ? 'text-tone-warn' : 'text-foreground'}>{busy}</span> : 'no live numbers'}
      {s.size ? ` · ${s.size}` : ''}
    </span>
  );
}

/** The Controls line: the server as swarmy sees it, for the lens in view. */
function techLine(s: ServerView, lens: Lens): string {
  if (lens === 'mesh') return `mesh ${s.mesh.ip ?? '—'} · ${s.mesh.state}`;
  if (lens === 'cost') return `swarmy.node.cost=${s.cost ?? 'unset'}`;
  return `${techRoles(s.node)} · ${s.node.publicIp ?? 'no public ip'}`;
}

/**
 * One server: the ring (the busier of CPU and memory), its name and roles,
 * the lens line, a reachability note, and your apps on it as small rows.
 */
export function ServerCard({ s, lens, style, className }: { s: ServerView; lens: Lens; style?: React.CSSProperties; className?: string }): React.JSX.Element {
  const st = serverTone(s.node);
  return (
    <article aria-label={`Server ${s.node.name}`} style={style} className={cn('bg-card border-border flex flex-col gap-1.5 overflow-hidden rounded-xl border p-3 shadow-sm', className)}>
      <div className="flex items-center gap-2.5">
        <RingGauge busy={s.busy} />
        <div className="min-w-0 flex-1">
          <Link to="/nodes/$nodeId" params={{ nodeId: s.node.id }} className="text-foreground flex items-center gap-1.5 text-sm font-semibold hover:underline pointer-coarse:min-h-11">
            <span aria-hidden className={cn('size-2 shrink-0 rounded-full', TONE_DOT[st.tone])} />
            <span className="truncate">{s.node.name}</span>
          </Link>
          <p className="text-muted-foreground truncate font-mono text-[12px]">
            {s.roles}
            {st.tone !== 'ok' ? <span className={TONE_TEXT[st.tone]}> · {st.word.toLowerCase()}</span> : null}
          </p>
        </div>
      </div>
      <div className="h-5 truncate font-mono text-[12px] leading-5">
        <LensLine s={s} lens={lens} />
      </div>
      {s.note ? <p className="text-muted-foreground h-5 truncate font-mono text-[12px] leading-5">{s.note}</p> : null}
      <Depth at="controls">
        <p className="text-muted-foreground h-5 truncate font-mono text-[12px] leading-5">{techLine(s, lens)}</p>
      </Depth>
      <ul className="flex flex-col gap-1">
        {s.apps.length === 0 ? (
          <li className="text-muted-foreground flex h-[30px] items-center text-[13px] pointer-coarse:h-11">Nothing of yours runs here</li>
        ) : (
          s.apps.map((a) => (
            <li key={a.app}>
              <Link
                to="/stacks/$name"
                params={{ name: a.app }}
                className="bg-foreground/[0.04] hover:bg-foreground/[0.08] flex h-[30px] items-center gap-2 rounded-lg px-2.5 text-[13px] pointer-coarse:h-11"
              >
                <span aria-hidden className={cn('size-2 shrink-0 rounded-full', TONE_DOT[a.tone])} />
                <span className="text-foreground max-w-[60%] shrink-0 truncate font-semibold">{a.app}</span>
                <span className={cn('ml-auto min-w-0 truncate font-mono text-[12px]', a.word ? TONE_TEXT[a.tone] : 'text-muted-foreground')}>
                  {a.word ?? a.parts}
                </span>
              </Link>
            </li>
          ))
        )}
      </ul>
    </article>
  );
}
