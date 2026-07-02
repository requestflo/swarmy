import * as React from 'react';

const STORAGE_KEY = 'swarmy-cost-dismissed-recs';

function readDismissed(): string[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : [];
  } catch {
    return [];
  }
}

/**
 * localStorage-backed dismissal for cost recommendations. Recommendation ids
 * are stable (rule + resource), so a dismissed nudge stays gone across reloads
 * until the user restores the feed.
 */
export function useDismissedRecs(): {
  dismissed: ReadonlySet<string>;
  dismiss: (id: string) => void;
  restoreAll: () => void;
} {
  const [ids, setIds] = React.useState<string[]>(() => readDismissed());

  const persist = React.useCallback((next: string[]) => {
    setIds(next);
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    } catch {
      // storage full/blocked — dismissal still applies for this session.
    }
  }, []);

  const dismiss = React.useCallback(
    (id: string) => persist([...new Set([...readDismissed(), id])]),
    [persist],
  );
  const restoreAll = React.useCallback(() => persist([]), [persist]);

  return { dismissed: React.useMemo(() => new Set(ids), [ids]), dismiss, restoreAll };
}
