import * as React from 'react';
import { Link } from '@tanstack/react-router';
import { ArrowUpRightIcon, XIcon } from 'lucide-react';
import { Button, cn } from '@swarmy/ui';
import { Depth, DepthScope, DepthSegments, useDepth, type DepthName } from '@/components/calm';
import { SettingsApplyBar } from './settings-apply-bar';
import { SettingsBody } from './settings-body';
import { SettingsCode } from './settings-code';
import { RunningPill, SourcePill, shortName } from './settings-pills';
import { useServiceSettings } from './use-service-settings';
import { useSettingsDraft } from './use-settings-draft';

/**
 * The part's settings panel (board ServiceSheet) — a right-hand panel over the
 * canvas on desktop, a full-height sheet on phones. Its own depth switch
 * starts at the page's; at Code the live compose opens beside the form.
 */
export function ServiceSettingsPanel({ serviceId, onClose }: { serviceId: string; onClose: () => void }): React.JSX.Element {
  const data = useServiceSettings(serviceId);
  const s = data.service;
  const d = useSettingsDraft(serviceId, data.spec, s?.replicas.desired ?? 0);
  const inherited = useDepth().depth;
  const [own, setOwn] = React.useState<DepthName | null>(null);
  const depth = own ?? inherited;
  const code = depth === 'code' && !!data.spec && !!s;
  const titleRef = React.useRef<HTMLHeadingElement>(null);

  React.useEffect(() => titleRef.current?.focus(), [serviceId]);
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const name = s ? shortName(s.name, s.stackId) : '';
  return (
    <aside
      aria-label={name ? `${name} settings` : 'Part settings'}
      className={cn(
        'bg-card border-border fixed inset-0 z-50 flex flex-col shadow-[0_24px_64px_-24px_rgb(0_0_0/0.6)] lg:inset-y-0 lg:right-0 lg:left-auto lg:z-40 lg:border-l',
        code ? 'lg:w-[min(1000px,calc(100vw-15rem))]' : 'lg:w-[460px]',
      )}
    >
      <header className="border-border flex items-start gap-3 border-b px-4 pt-3 pb-3 lg:px-5">
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <p className="text-muted-foreground font-mono text-[11px] tracking-[0.08em] uppercase">Part settings</p>
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <h2 ref={titleRef} tabIndex={-1} className="font-display truncate text-[22px] font-bold tracking-[-0.02em] outline-none">
              {name || '…'}
            </h2>
            {s ? <RunningPill service={s} /> : null}
            {s ? <SourcePill git={data.git} stack={s.stackId} name={s.name} /> : null}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <Button asChild variant="ghost" size="icon" className="size-8 pointer-coarse:size-11">
            <Link to="/services/$serviceId" params={{ serviceId }} aria-label="Open as a page">
              <ArrowUpRightIcon className="size-4" />
            </Link>
          </Button>
          <Button variant="ghost" size="icon" className="size-8 pointer-coarse:size-11" onClick={onClose} aria-label="Close">
            <XIcon className="size-4" />
          </Button>
        </div>
      </header>
      <div className="border-border flex items-center gap-2 border-b px-4 py-2 lg:px-5">
        <DepthSegments value={depth} onChange={setOwn} label="Detail in this panel" size="sm" />
        <span className="text-muted-foreground hidden text-xs sm:inline">{code ? 'form + live compose' : 'form'}</span>
      </div>
      <DepthScope depth={own}>
        <div className={cn('min-h-0 flex-1 overflow-y-auto', code && 'lg:grid lg:grid-cols-[440px_minmax(0,1fr)] lg:overflow-hidden')}>
          <div className={cn('px-4 pb-6 lg:px-5', code && 'lg:overflow-y-auto')}>
            <SettingsBody data={data} d={d} />
          </div>
          {code && s && data.spec ? (
            <Depth at="code">
              <SettingsCode
                className="border-border border-t px-4 py-4 lg:overflow-y-auto lg:border-t-0 lg:border-l lg:px-5"
                short={name}
                serviceId={serviceId}
                spec={data.spec}
                draft={d.draft}
                git={data.git}
                fill
              />
            </Depth>
          ) : null}
        </div>
      </DepthScope>
      <SettingsApplyBar d={d} className="pb-[max(0.75rem,env(safe-area-inset-bottom))]" />
    </aside>
  );
}
