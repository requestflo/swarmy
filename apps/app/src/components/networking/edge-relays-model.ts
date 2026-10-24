/** Relays on edges, as the control-plane card shows them (`mesh.control.status().relays`). */
export interface EdgeRelaysView {
  enabled: boolean;
  active: boolean;
  edges: { hostname: string; address: string; running: boolean; healthy: boolean }[];
}

/** The plain-words line for the relays. Pure. */
export function edgeRelaysSentence(r: EdgeRelaysView): string {
  if (!r.enabled) return "Servers that can't reach each other directly go through this control plane.";
  if (!r.edges.length) return 'No front door has a public address yet, so traffic still goes through this control plane.';
  const n = r.edges.length;
  const doors = `${n} front door${n === 1 ? '' : 's'}`;
  if (!r.active) return `Starting relays on ${doors}…`;
  const up = r.edges.filter((e) => e.healthy).length;
  return `Relayed traffic goes through ${doors} (${up} answering), so it keeps flowing if this node is gone.`;
}
