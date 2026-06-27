import * as React from 'react';
import { Sidenav } from './sidenav';
import { MobileHeader, MobileTabBar } from './mobile-chrome';

export function AppShell({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <div className="bg-background min-h-screen">
      <Sidenav />
      <MobileHeader />
      <div className="lg:pl-64">
        <main className="min-h-[calc(100dvh-3.5rem)] pb-28 lg:min-h-screen lg:pb-0">
          {children}
        </main>
      </div>
      <MobileTabBar />
    </div>
  );
}
