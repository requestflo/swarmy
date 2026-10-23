import * as React from 'react';

/** How a link reads: `hot` = the lit path, `base` = quiet, `dim` = not on the lit path, `mesh` = certificates / private network. */
export type FlowTone = 'hot' | 'base' | 'dim' | 'mesh';

export interface FlowLink {
  from: string;
  to: string;
  tone: FlowTone;
  dashed?: boolean;
  /** `across` = right side → left side (the default); `left` = a loop on the left of both cards. */
  route?: 'across' | 'left';
}

export interface FlowPath extends FlowLink {
  key: string;
  d: string;
}

/**
 * Curves between the cards of a flow diagram, measured off the real DOM: each
 * card carries `data-flow="<id>"`, so text never scales and the layout stays
 * CSS. Re-measures on resize and whenever the links change.
 */
export function useFlowPaths(links: FlowLink[]): {
  ref: React.RefCallback<HTMLElement>;
  paths: FlowPath[];
  size: { w: number; h: number };
} {
  const [el, setEl] = React.useState<HTMLElement | null>(null);
  const [state, setState] = React.useState<{ paths: FlowPath[]; size: { w: number; h: number } }>({ paths: [], size: { w: 0, h: 0 } });
  const key = links.map((l) => `${l.from}>${l.to}:${l.tone}:${l.dashed ? 1 : 0}:${l.route ?? ''}`).join('|');

  const measure = React.useCallback(() => {
    if (!el) return;
    const box = el.getBoundingClientRect();
    const rect = (id: string): DOMRect | null => el.querySelector(`[data-flow="${CSS.escape(id)}"]`)?.getBoundingClientRect() ?? null;
    const paths: FlowPath[] = [];
    for (const l of links) {
      const a = rect(l.from);
      const b = rect(l.to);
      if (!a || !b || a.width === 0 || b.width === 0) continue;
      const ay = a.top + a.height / 2 - box.top;
      const by = b.top + b.height / 2 - box.top;
      let d: string;
      if (l.route === 'left') {
        const ax = a.left - box.left;
        const bx = b.left - box.left;
        const out = Math.min(ax, bx) - 28;
        d = `M${ax} ${ay} C ${out} ${ay} ${out} ${by} ${bx} ${by}`;
      } else {
        const ax = a.right - box.left;
        const bx = b.left - box.left;
        const mid = (bx - ax) / 2;
        d = `M${ax} ${ay} C ${ax + mid} ${ay} ${bx - mid} ${by} ${bx} ${by}`;
      }
      paths.push({ ...l, key: `${l.from}>${l.to}`, d });
    }
    setState({ paths, size: { w: box.width, h: box.height } });
    // `key` stands in for the links' identities.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [el, key]);

  React.useLayoutEffect(() => {
    measure();
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => measure());
    ro.observe(el);
    for (const child of el.querySelectorAll('[data-flow]')) ro.observe(child);
    return () => ro.disconnect();
  }, [el, measure]);

  return { ref: setEl, paths: state.paths, size: state.size };
}
