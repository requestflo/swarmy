/**
 * Safety net for any tRPC path without an explicit demo resolver: return a benign
 * shape inferred from the leaf verb so no page crashes in demo mode. Real surfaces
 * are covered by the resolver modules; this only catches the long tail.
 */
const LIST_LEAF = /^(list|traces|tags|search|members|simulate)/i;
const READ_LEAF = /^(get|status|overview|summary|currentOrg|whoami|preview|export|parse|detail|recording|generate)/i;

export function fallback(path: string, _input: unknown): unknown {
  const leaf = path.split('.').pop() ?? '';
  if (LIST_LEAF.test(leaf)) return [];
  if (READ_LEAF.test(leaf)) return null;
  // mutations / actions / toggles
  return { ok: true };
}
