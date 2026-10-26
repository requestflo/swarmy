import * as React from 'react';
import { Link } from '@tanstack/react-router';
import { cn } from '@swarmy/ui';
import { SectionLink, TONE_DOT } from '@/components/calm';
import { canEnterPath, ruleFor, rulePath, ruleWho } from './path-rules-model';
import { personName } from './simulate';
import type { AppAccessRoute, AppAccessViewData } from './types';

interface Props {
  view: AppAccessViewData;
  route: AppAccessRoute;
  path: string;
  label: string;
}

/**
 * "Who can enter <address>" (AppAccess board): the rule that decides this
 * path in a line, then each member with whether they get in, from the same
 * matcher the edge check uses. Members and their groups live in Members &
 * roles.
 */
export function WhoCanEnterPath({ view, route, path, label }: Props): React.JSX.Element {
  const rule = ruleFor(route, path);
  const inside = view.people.filter((p) => canEnterPath(route, p, path));
  const line = route.pathRulesError
    ? "Its path rules can't be read, so nobody gets in until an admin fixes them."
    : rule && !rule.everyone
      ? `${rulePath(rule)} only admits ${ruleWho(rule, view.people)}, if the app lets them in.`
      : 'Everyone the app lets in.';

  return (
    <div className="border-border flex flex-col gap-2 border-t pt-3">
      <div className="flex flex-wrap items-baseline gap-x-2.5 gap-y-1">
        <h3 className="text-[14px] font-semibold">Who can enter {label}</h3>
        <span className="text-muted-foreground text-[12.5px]">
          {inside.length} of {view.people.length}
        </span>
        <Link to="/settings/access" className="ml-auto">
          <SectionLink>from Members &amp; roles →</SectionLink>
        </Link>
      </div>
      <p className="text-muted-foreground text-[13px]">{line}</p>
      <ul className="flex flex-wrap gap-x-4 gap-y-1.5" aria-label={`Who can enter ${label}`}>
        {view.people.map((p) => {
          const ok = inside.includes(p);
          return (
            <li key={p.memberId} className={cn('flex items-center gap-1.5 text-[13px]', !ok && 'text-muted-foreground')}>
              <span aria-hidden className={cn('size-1.5 rounded-full', TONE_DOT[ok ? 'ok' : 'idle'])} />
              {personName(p)}
              <span className="sr-only">{ok ? 'can enter' : 'cannot enter'}</span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
