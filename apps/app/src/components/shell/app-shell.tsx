import * as React from 'react';
import { Sidenav } from './sidenav';
import { MobileHeader, MobileTabBar } from './mobile-chrome';
import { CommandPaletteProvider } from './command-palette-provider';
import { isDemo } from '@/demo/is-demo';
import { DemoBanner } from '@/demo/demo-banner';

/**
 * The shell: a fixed navy sidenav (desktop) / compact header + bottom tab bar
 * (mobile) around a full-bleed content area, with the global ⌘K palette mounted
 * at the root. The sidenav is the primary wayfinding — every destination is one
 * glance away, grouped — with the palette as the fast path.
 *
 * Content is offset by the sidenav on `lg`; each page owns its own container.
 * `pb-28` keeps the mobile tab bar from covering content.
 */
export function AppShell({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <CommandPaletteProvider>
      <div className="bg-background min-h-screen">
        <Sidenav />
        <div className="flex min-h-screen flex-col lg:pl-64">
          {isDemo() && <DemoBanner />}
          <MobileHeader />
          <main className="min-h-[calc(100dvh-3.5rem)] flex-1 pb-28 lg:min-h-0 lg:pb-0">{children}</main>
          <MobileTabBar />
        </div>
      </div>
    </CommandPaletteProvider>
  );
}
