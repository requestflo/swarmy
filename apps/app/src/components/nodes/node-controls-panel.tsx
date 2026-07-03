import * as React from 'react';
import { SlidersHorizontalIcon } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@swarmy/ui';
import type { NodeDetail } from '@swarmy/core';
import { NodeRegionCostForm } from './node-region-cost-form';
import { NodeRoleSwitches } from './node-role-switches';
import { NodeLabelsEditor } from './node-labels-editor';
import { NodeDangerControls } from './node-danger-controls';

interface NodeControlsPanelProps {
  node: NodeDetail | undefined;
  monthlyUsd: number | null;
}

/**
 * Every node control, consolidated in one place — region, price, roles,
 * labels, availability, and remove — all inline. No dialogs for editing;
 * the only modals here are the two destructive AlertDialog confirms.
 */
export function NodeControlsPanel({ node, monthlyUsd }: NodeControlsPanelProps): React.JSX.Element {
  return (
    <Card className="card-pop mt-6 border-0">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <SlidersHorizontalIcon className="text-primary size-4" /> Controls
        </CardTitle>
      </CardHeader>
      <CardContent className="divide-border grid gap-5 divide-y">
        <NodeRegionCostForm
          nodeId={node?.id ?? ''}
          region={node?.region ?? null}
          monthlyUsd={monthlyUsd}
        />
        <div className="pt-5">
          <NodeRoleSwitches
            nodeId={node?.id ?? ''}
            ingress={node?.ingress ?? false}
            outlet={node?.outlet ?? false}
          />
        </div>
        <div className="pt-5">
          <NodeLabelsEditor nodeId={node?.id ?? ''} labels={node?.labels ?? {}} />
        </div>
        <div className="pt-5">
          <NodeDangerControls nodeId={node?.id ?? ''} name={node?.name ?? 'node'} status={node?.status} />
        </div>
      </CardContent>
    </Card>
  );
}
