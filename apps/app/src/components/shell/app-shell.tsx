import * as React from 'react';
import { CommandBar } from './command-bar';
import { MobileHeader, MobileTabBar } from './mobile-chrome';
import { CommandPaletteProvider } from './command-palette-provider';

/**
 * The redesigned shell: a floating command bar (desktop) / compact header
 * (mobile) over a full-bleed content area, with the global ⌘K palette mounted at
 * the root. No sidenav — navigation is the plane tabs + the palette.
 *
 * Content is full-width; each page owns its container. Canvas surfaces
 * (Applications / Infrastructure) fill the viewport; document pages keep their
 * own max-width. `pb-28` keeps the mobile tab bar from covering content.
 */
export function AppShell({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <CommandPaletteProvider>
      <div className="bg-background flex min-h-screen flex-col">
        <CommandBar />
        <MobileHeader />
        <main className="min-h-[calc(100dvh-3.5rem)] flex-1 pb-28 lg:min-h-0 lg:pb-0">{children}</main>
        <MobileTabBar />
      </div>
    </CommandPaletteProvider>
  );
}
