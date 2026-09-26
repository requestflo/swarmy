import * as React from 'react';
import { Sidenav } from './sidenav';
import { MobileHeader, MobileTabBar } from './mobile-chrome';
import { CommandPaletteProvider } from './command-palette-provider';
import { isDemo } from '@/demo/is-demo';
import { DemoBanner } from '@/demo/demo-banner';
import { DepthProvider } from '@/components/calm/depth';

/**
 * The shell: a fixed navy sidenav (desktop) / compact header + bottom tab bar
 * (mobile) around a full-bleed content area, with the global ⌘K palette and
 * the Calm Layers depth (Summary · Controls · Code) mounted at the root.
 *
 * Content is offset by the sidenav on `lg`; each page owns its own container.
 * `pb-28` keeps the mobile tab bar from covering content.
 */
export function AppShell({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <CommandPaletteProvider>
      <DepthProvider>
      <div className="bg-background relative min-h-screen">
        {/* The fixed sidenav covers the viewport; this strip carries its navy down
            the whole document, so tall pages (and full-page captures, overscroll)
            never show the page ground under the nav column. */}
        <div aria-hidden className="bg-nav pointer-events-none absolute inset-y-0 left-0 hidden w-60 border-r border-[var(--nav-line)] lg:block" />
        <Sidenav />
        <div className="flex min-h-screen flex-col lg:pl-60">
          {isDemo() && <DemoBanner />}
          <MobileHeader />
          <main className="min-h-[calc(100dvh-3.5rem)] flex-1 pb-28 lg:min-h-0 lg:pb-0">{children}</main>
          <MobileTabBar />
        </div>
      </div>
      </DepthProvider>
    </CommandPaletteProvider>
  );
}
