import * as React from 'react';
import { useLocation } from '@tanstack/react-router';
import { LayoutGridIcon } from 'lucide-react';
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  cn,
} from '@swarmy/ui';
import { useGo } from '@/lib/use-go';
import { SECTIONS, type DestinationGroup } from '@/lib/destinations';

const ORDER: DestinationGroup[] = ['Deploy', 'Networking', 'Delivery', 'Data', 'Observability', 'Settings'];

/** Top-bar overflow: every non-plane destination, grouped. The ⌘K palette is the fast path; this is the discoverable one. */
export function SectionsMenu(): React.JSX.Element {
  const go = useGo();
  const { pathname } = useLocation();
  // Most-specific match wins so a parent (/settings) isn't lit alongside its
  // child (/settings/access).
  const activeTo = React.useMemo(() => {
    const matches = SECTIONS.filter((s) => pathname === s.to || pathname.startsWith(`${s.to}/`));
    return matches.sort((a, b) => b.to.length - a.to.length)[0]?.to ?? null;
  }, [pathname]);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="sm" className="gap-2 font-medium">
          <LayoutGridIcon className="size-4" />
          <span className="hidden md:inline">More</span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-60">
        {ORDER.map((group, i) => (
          <React.Fragment key={group}>
            {i > 0 && <DropdownMenuSeparator />}
            <DropdownMenuLabel className="text-muted-foreground text-xs">{group}</DropdownMenuLabel>
            {SECTIONS.filter((s) => s.group === group).map((s) => {
              const active = pathname === s.to || pathname.startsWith(`${s.to}/`);
              return (
                <DropdownMenuItem key={s.to} onClick={() => go(s.to)} className={cn(active && 'text-primary font-semibold')}>
                  <s.icon className="size-4" />
                  {s.label}
                </DropdownMenuItem>
              );
            })}
          </React.Fragment>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
