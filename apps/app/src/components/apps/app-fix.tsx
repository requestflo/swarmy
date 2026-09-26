import * as React from 'react';
import { Link } from '@tanstack/react-router';
import { Button } from '@swarmy/ui';
import { Depth } from '@/components/calm';
import { RollbackConfirm } from '@/components/releases/rollback-confirm';
import { releaseLabel } from '@/components/app-tabs/releases/release-label';
import type { BoardRow } from './app-board-model';

/**
 * The inline fix under an app that needs you: what's wrong in a sentence, the
 * put-back (the existing confirm → `releases.rollback`) when there is an
 * earlier healthy version, and the open incident when there is one. Only the
 * first app that needs you gets the coral button (one coral per screen).
 */
export function AppFix({ row, primary }: { row: BoardRow; primary: boolean }): React.JSX.Element | null {
  const fix = row.fix;
  if (!fix) return null;
  const label = fix.putBack ? releaseLabel(fix.putBack) : null;
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 pb-3 @4xl:pl-[46px] @4xl:pr-[18px]">
      <p className="text-foreground/80 min-w-0 flex-1 basis-72 text-[13px] leading-snug">{fix.diagnosis}</p>
      {fix.putBack ? (
        <>
          <span className="text-muted-foreground font-mono text-[11px]">one copy at a time · your data isn’t touched</span>
          <RollbackConfirm
            release={fix.putBack}
            label={label ?? undefined}
            trigger={
              <Button size="sm" variant={primary ? 'default' : 'outline'} className="pointer-coarse:min-h-11">
                Put back {label}
              </Button>
            }
          />
        </>
      ) : null}
      {fix.incidentId ? (
        <Button asChild size="sm" variant="outline" className="pointer-coarse:min-h-11">
          <Link to="/incidents/$incidentId" params={{ incidentId: fix.incidentId }}>
            Open incident
          </Link>
        </Button>
      ) : null}
      {fix.putBack ? (
        <Depth at="controls">
          <span className="text-muted-foreground w-full font-mono text-[11px]">
            releases.rollback · redeploys {fix.putBack.images.map((i) => i.image).join(', ')} as a new release
          </span>
        </Depth>
      ) : null}
    </div>
  );
}
