import * as React from 'react';
import { parseAppConfig, toDesired, type AppConfig, type ParseResult } from '@swarmy/app-config';
import { diffGraphs, graphOf, type Graph, type GraphDiff } from './graph-model';
import { changedLines } from './yaml-highlight';
import type { LineMark } from './yaml-lines';

function graphFor(config: AppConfig | undefined): Graph | null {
  if (!config) return null;
  try {
    return graphOf(toDesired(config));
  } catch {
    return null;
  }
}

/**
 * The editor's working copy of swarmy.yaml: the saved text until you type,
 * parsed live with the controller's own parser (deferred, so typing stays
 * smooth), the graph of the last version that parsed, and how both differ
 * from the saved file. Nothing is written anywhere — this is a scratchpad.
 */
export function useYamlDraft(saved: string) {
  const [draft, setDraft] = React.useState<string | null>(null);
  const text = draft ?? saved;
  const deferred = React.useDeferredValue(text);
  const parsed: ParseResult = React.useMemo(() => parseAppConfig(deferred), [deferred]);
  const savedParsed = React.useMemo(() => parseAppConfig(saved), [saved]);
  const savedGraph = React.useMemo(() => graphFor(savedParsed.config), [savedParsed]);
  const current = React.useMemo(() => graphFor(parsed.config), [parsed]);

  // While a half-typed line doesn't parse, keep showing the last version that did.
  const [lastGood, setLastGood] = React.useState<Graph | null>(null);
  React.useEffect(() => {
    if (current) setLastGood(current);
  }, [current]);
  const graph = current ?? lastGood ?? savedGraph;

  const dirty = draft !== null && draft !== saved;
  const diff: GraphDiff | null = React.useMemo(
    () => (graph ? diffGraphs(dirty ? savedGraph : null, graph, parsed.issues) : null),
    [graph, savedGraph, dirty, parsed.issues],
  );

  const marks = React.useMemo(() => {
    const m = new Map<number, LineMark>();
    if (dirty) for (const n of changedLines(saved, deferred)) m.set(n, { changed: true });
    for (const i of parsed.issues) {
      if (!i.line) continue;
      const was = m.get(i.line);
      if (was?.severity === 'error') continue;
      m.set(i.line, { ...was, severity: i.severity });
    }
    return m;
  }, [dirty, saved, deferred, parsed.issues]);

  return {
    text,
    setText: setDraft,
    reset: React.useCallback(() => setDraft(null), []),
    dirty,
    parsed,
    /** True while `parsed` lags the text (it's deferred). */
    stale: deferred !== text,
    graph,
    /** Showing the last valid version because the current text has errors. */
    graphIsOld: !current && Boolean(graph),
    diff,
    marks,
    /** The saved file's config (what swarmy applies), when it parses. */
    savedConfig: savedParsed.config,
  };
}
