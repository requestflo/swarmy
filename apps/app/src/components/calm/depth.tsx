import * as React from 'react';
import { useLocation } from '@tanstack/react-router';
import { useSavedDepth } from './depth-saved';

/**
 * Calm Layers depth: every screen reads at three depths, and each adds detail
 * to the one below — it never moves or removes anything.
 *
 *   summary  — a plain sentence and the one next action
 *   controls — the forms, with technical detail inline
 *   code     — the exact swarmy.yaml / CLI / REST
 *
 * Three scopes, innermost wins: a section's own switch → this page's switch
 * (top bar; resets to the default on navigation) → the person's default (the
 * sidenav "Show me" dial). The default is saved server-side
 * (`org.myPreferences`) so it follows the person across browsers;
 * localStorage (`swarmy-depth:<userId>`) is the cache that paints the first
 * frame before the query answers.
 */
export type DepthName = 'summary' | 'controls' | 'code';
export const DEPTHS: readonly DepthName[] = ['summary', 'controls', 'code'];
export const DEPTH_LABEL: Record<DepthName, string> = {
  summary: 'Summary',
  controls: 'Controls',
  code: 'Code',
};
const RANK: Record<DepthName, number> = { summary: 0, controls: 1, code: 2 };

interface DefaultCtx {
  /** The person's default depth. */
  value: DepthName;
  /** Whether they've ever chosen one (the first-run "Show me" card asks). */
  chosen: boolean;
  set: (d: DepthName) => void;
  /** This page's depth (the top-bar switch), before any section override. */
  page: DepthName;
  setPage: (d: DepthName) => void;
}

const DefaultContext = React.createContext<DefaultCtx | null>(null);
/** A section's own override; `null` = inherit the page's depth. */
const SectionContext = React.createContext<DepthName | null>(null);

export function DepthProvider({ children }: { children: React.ReactNode }): React.JSX.Element {
  const { stored, save } = useSavedDepth();
  const value: DepthName = stored ?? 'summary';
  const { pathname } = useLocation();
  // The page override is keyed by pathname, so navigating resets it to the default.
  const [pageOverride, setPageOverride] = React.useState<{ path: string; d: DepthName } | null>(null);
  const page = pageOverride && pageOverride.path === pathname ? pageOverride.d : value;

  const ctx = React.useMemo<DefaultCtx>(
    () => ({
      value,
      chosen: stored !== null,
      set: (d) => {
        save(d);
        setPageOverride(null);
      },
      page,
      setPage: (d) => setPageOverride({ path: pathname, d }),
    }),
    [value, stored, save, page, pathname],
  );
  return <DefaultContext.Provider value={ctx}>{children}</DefaultContext.Provider>;
}

function useDefaultCtx(): DefaultCtx {
  const ctx = React.useContext(DefaultContext);
  if (!ctx) {
    // Outside the shell (sign-in, public pages): a fixed Summary, no switching.
    return { value: 'summary', chosen: true, set: () => {}, page: 'summary', setPage: () => {} };
  }
  return ctx;
}

/** The person's default depth and its setter (the sidenav dial, first-run card). */
export function useDepthDefault(): Pick<DefaultCtx, 'value' | 'chosen' | 'set'> {
  const { value, chosen, set } = useDefaultCtx();
  return { value, chosen, set };
}

/** This page's depth and its setter (the top-bar switch). */
export function usePageDepth(): { depth: DepthName; setDepth: (d: DepthName) => void } {
  const { page, setPage } = useDefaultCtx();
  return { depth: page, setDepth: setPage };
}

export interface DepthState {
  depth: DepthName;
  /** True from `d` up: `atLeast('controls')` is true at Controls and Code. */
  atLeast: (d: DepthName) => boolean;
}

/** The effective depth here: section override → page → default. */
export function useDepth(): DepthState {
  const { page } = useDefaultCtx();
  const section = React.useContext(SectionContext);
  const depth = section ?? page;
  return { depth, atLeast: (d) => RANK[depth] >= RANK[d] };
}

/** Scope a subtree to its own depth (a switchable `Section`). */
export function DepthScope({
  depth,
  children,
}: {
  depth: DepthName | null;
  children: React.ReactNode;
}): React.JSX.Element {
  if (depth === null) return <>{children}</>;
  return <SectionContext.Provider value={depth}>{children}</SectionContext.Provider>;
}

/**
 * Render children from depth `at` upward (`only` = exactly that depth).
 * `<Depth at="controls">` is how a page adds knobs; `<Depth at="code">` adds
 * the code view. Summary content needs no wrapper — it is always there.
 */
export function Depth({
  at,
  only,
  children,
}: {
  at?: DepthName;
  only?: DepthName;
  children: React.ReactNode;
}): React.JSX.Element | null {
  const { depth, atLeast } = useDepth();
  if (only) return depth === only ? <>{children}</> : null;
  return atLeast(at ?? 'summary') ? <>{children}</> : null;
}
