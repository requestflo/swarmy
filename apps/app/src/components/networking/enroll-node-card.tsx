import * as React from 'react';
import {
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  EmptyState,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@swarmy/ui';
import { WaypointsIcon } from 'lucide-react';

interface NodeOption {
  id: string;
  name: string;
}

interface EnrollNodeCardProps {
  active: boolean;
  nodes: NodeOption[];
  enrollNodeId: string;
  onEnrollNodeIdChange: (id: string) => void;
  onEnroll: (nodeId: string) => void;
  isPending: boolean;
}

/** Networking → provision a single-use setup key and join a node to the mesh. */
export function EnrollNodeCard({
  active,
  nodes,
  enrollNodeId,
  onEnrollNodeIdChange,
  onEnroll,
  isPending,
}: EnrollNodeCardProps): React.JSX.Element {
  return (
    <Card className="card-pop border-0">
      <CardHeader>
        <CardTitle className="text-base">Enroll a node</CardTitle>
        <CardDescription>
          Provision a single-use setup key and join a node to the mesh. The agent installs the NetBird
          client — no inbound ports, no firewall edits.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-3">
        {!active ? (
          <EmptyState
            icon={<WaypointsIcon />}
            title="Mesh is off"
            description="Pick NetBird and flip the master switch on to start enrolling nodes."
            className="border-0 py-10"
          />
        ) : (
          <>
            <Label className="mono-label">Node</Label>
            <div className="flex gap-2">
              <Select value={enrollNodeId} onValueChange={onEnrollNodeIdChange}>
                <SelectTrigger>
                  <SelectValue placeholder="Select a node" />
                </SelectTrigger>
                <SelectContent>
                  {nodes.map((n) => (
                    <SelectItem key={n.id} value={n.id}>
                      {n.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button onClick={() => onEnroll(enrollNodeId)} disabled={isPending || !enrollNodeId}>
                Enroll
              </Button>
            </div>
            <p className="text-muted-foreground text-xs">
              The setup key is single-use and short-lived; it never touches disk on the node.
            </p>
          </>
        )}
      </CardContent>
    </Card>
  );
}
