import type { CodeTab } from '@/components/calm';
import { caddyfileOf, siteBlock, type PreviewLike } from '@/components/ingress/caddyfile-text';
import { edgeDiff } from './edge-diff';

/** One edge's render, as `ingress.edgeConfigs` returns it. */
export interface EdgeRender {
  nodeId: string;
  name: string;
  region: string | null;
  rendered: PreviewLike;
}

export function edgeLabel(e: Pick<EdgeRender, 'name' | 'region'>): string {
  return e.region ? `${e.name} (${e.region})` : e.name;
}

/** The edge shown and the one it is compared with: the picks when they still exist, else the first two. */
export function pickEdges(edges: EdgeRender[], on: string | null, vs: string | null): { edge?: EdgeRender; other?: EdgeRender } {
  const edge = edges.find((e) => e.nodeId === on) ?? edges[0];
  const rest = edges.filter((e) => e.nodeId !== edge?.nodeId);
  return { edge, other: rest.find((e) => e.nodeId === vs) ?? rest[0] };
}

/**
 * The Code view's tabs: the picked address's site block on this edge, the
 * whole file, and (with a second edge) the diff against it. `text` is the
 * file to show when no edge is running (the org-wide render).
 */
export function caddyTabs(o: {
  selected: string | null;
  edge?: EdgeRender;
  other?: EdgeRender;
  text: string | null;
  pending: boolean;
  regional: boolean;
}): CodeTab[] {
  const text = o.edge ? caddyfileOf(o.edge.rendered) : o.text;
  const whole = text ?? (o.pending ? '# rendering…' : '# swarmy writes no Caddyfile right now');
  const block = text && o.selected ? siteBlock(text, o.selected) : null;
  const tabs: CodeTab[] = [
    ...(o.selected ? [{ label: o.selected, code: block ?? `# ${o.selected} is not in the rendered file yet: it is withheld until its DNS verifies` }] : []),
    { label: 'Whole file', code: whole },
  ];
  if (o.edge && o.other) {
    const theirs = caddyfileOf(o.other.rendered) ?? '';
    const diff = edgeDiff({ label: edgeLabel(o.edge), text: text ?? '' }, { label: edgeLabel(o.other), text: theirs });
    const same = [
      `# ${o.edge.name} and ${o.other.name} run the same Caddyfile, byte for byte.`,
      o.regional
        ? '# They list the same app copies first, so their files match.'
        : '# No app has copies in more than one region, so every edge renders the same file.',
    ].join('\n');
    tabs.push({ label: `vs ${o.other.name}`, code: diff ?? same });
  }
  return tabs;
}
