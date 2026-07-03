import * as React from 'react';
import type { Node } from '@xyflow/react';
import type { CanvasNode } from './build-graph';

/**
 * Selection state for the canvas's docked inspector: at most one of a service
 * or a db-cluster is selected at a time, so picking one always closes the other.
 */
export function useCanvasSelection(): {
  selected: string | null;
  dbCluster: { stack: string; cluster: string } | null;
  inspectorOpen: boolean;
  closeInspector: () => void;
  onNodeClick: (node: Node) => void;
} {
  const [selected, setSelected] = React.useState<string | null>(null);
  const [dbCluster, setDbCluster] = React.useState<{ stack: string; cluster: string } | null>(null);

  const closeInspector = React.useCallback((): void => {
    setSelected(null);
    setDbCluster(null);
  }, []);

  const onNodeClick = React.useCallback((node: Node): void => {
    const n = node as CanvasNode;
    if (n.type === 'service') {
      setDbCluster(null);
      setSelected(n.id);
    } else if (n.type === 'dbCluster') {
      setSelected(null);
      setDbCluster({ stack: n.data.stack, cluster: n.data.cluster });
    }
  }, []);

  return { selected, dbCluster, inspectorOpen: !!selected || !!dbCluster, closeInspector, onNodeClick };
}
