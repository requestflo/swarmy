import * as React from 'react';
import type { AppsView } from '@/components/apps/apps-view-toggle';

const KEY = 'swarmy-servers-view';

/** Servers: Map (board 11, the default) or List, remembered per browser — a view, never navigation. */
export function useServersView(): [AppsView, (v: AppsView) => void] {
  const [view, setView] = React.useState<AppsView>(() => {
    try {
      return window.localStorage.getItem(KEY) === 'list' ? 'list' : 'map';
    } catch {
      return 'map';
    }
  });
  const set = React.useCallback((v: AppsView) => {
    setView(v);
    try {
      window.localStorage.setItem(KEY, v);
    } catch {
      // storage unavailable: the choice lasts for this visit
    }
  }, []);
  return [view, set];
}
