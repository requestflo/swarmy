import * as React from 'react';
import { Link } from '@tanstack/react-router';
import { Button } from '@swarmy/ui';
import type { ServerGlance } from './use-servers-glance';
import { WelcomeServerCard } from './welcome-server-card';

/** A dashed ghost ring: where the next server could go (links to Add a server). */
function GhostRing({ label, className }: { label: string; className: string }): React.JSX.Element {
  return (
    <Link
      to="/nodes/new"
      aria-label={`Add a server: ${label}`}
      className={`border-foreground/20 text-muted-foreground hover:border-foreground/40 hover:text-foreground absolute flex items-center justify-center rounded-full border border-dashed p-8 text-center font-mono text-[11px] leading-relaxed outline-none focus-visible:ring-2 focus-visible:ring-ring/50 ${className}`}
    >
      {label}
    </Link>
  );
}

/**
 * The Welcome board's right side: the server sitting in its region (a soft
 * blob), dashed rings for where more servers could join, and a preview of
 * step 1. Decoration is tokens + CSS/SVG only; every fact comes from the node.
 */
export function WelcomePicture({ server, dashboardHere }: { server: ServerGlance; dashboardHere: boolean }): React.JSX.Element {
  const region = server.node.region;
  return (
    <div className="relative min-h-[640px] overflow-hidden [background-image:radial-gradient(var(--border)_1px,transparent_1px)] [background-size:22px_22px]">
      <section aria-label="Step 1 preview" className="calm-card absolute top-0 right-0 z-10 flex w-[min(19rem,100%)] flex-col gap-2 px-4 py-3.5">
        <span className="calm-eyebrow">Step 1 · preview</span>
        <h2 className="text-[15px] font-semibold">An app lands on {server.node.name}</h2>
        <p className="text-muted-foreground text-[13px] leading-relaxed">
          We pick the server, create its database if it needs one, and give it a working https address straight away — no DNS needed yet.
        </p>
        <Button asChild variant="outline" size="sm" className="self-start pointer-coarse:min-h-11">
          <Link to="/blueprints">Browse templates</Link>
        </Button>
      </section>

      <GhostRing label="a second server anywhere" className="top-[215px] left-0 size-44" />
      <GhostRing label="even one at home, behind your router" className="right-0 bottom-0 size-48" />

      <div className="absolute top-[330px] left-[56%] w-[min(20rem,80%)] -translate-x-1/2">
        <svg aria-hidden viewBox="0 0 340 260" className="absolute -inset-x-12 -top-14 -bottom-12 h-[calc(100%+6.5rem)] w-[calc(100%+6rem)]" preserveAspectRatio="none">
          <path
            d="M60 40 C120 -6 250 0 300 50 C350 100 336 190 280 226 C220 264 110 262 56 214 C6 170 4 84 60 40 Z"
            className="fill-foreground/[0.035] stroke-foreground/20"
            strokeWidth="1"
            vectorEffect="non-scaling-stroke"
          />
        </svg>
        {region ? <span className="calm-eyebrow relative mb-2 block">{region.toUpperCase()}</span> : null}
        <WelcomeServerCard server={server} dashboardHere={dashboardHere} className="relative" />
      </div>
    </div>
  );
}
